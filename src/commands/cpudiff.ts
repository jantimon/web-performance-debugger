import type { CpuDiffResult, CpuFunctionDelta, CpuPackageDelta } from "../model/query.js";
import type { CpuFunction } from "../model/recording.js";
import { num, table } from "../output/ascii.js";
import { serialize, isFormat, type Format } from "../output/format.js";
import {
  packageRollup,
  functionJoinKey,
  loadCpuModel,
  shortSource,
} from "../profile/cpuprofile.js";
import { comparabilityMismatches, CPU_DIFF_BLOCKING_AXES } from "../model/compat.js";
import { resolveVerbTarget } from "./group.js";

/** Self-time deltas below this are treated as sampling noise. */
const NOISE_MS = 0.5;
const TOP_FUNCTIONS = 25;

/**
 * Index a model's functions by their cross-run join key, SUMMING self/total time on a collision. Two
 * functions can share a key (same name in the same file: overloads, or a name reused at two lines --
 * `functionJoinKey` joins on the bare file, not the line, so a line shift does not split the join).
 * A plain `new Map(...)` would keep only the last, silently dropping the other's self-time from the
 * delta; summing makes the row reflect the whole line. The first entry is copied so the loaded model
 * is never mutated.
 */
function functionsByJoinKey(functions: CpuFunction[]): Map<string, CpuFunction> {
  const byKey = new Map<string, CpuFunction>();
  for (const fn of functions) {
    const key = functionJoinKey(fn);
    const existing = byKey.get(key);
    if (existing) {
      existing.selfMs += fn.selfMs;
      existing.totalMs += fn.totalMs;
    } else {
      byKey.set(key, { ...fn });
    }
  }
  return byKey;
}

interface DiffOpts {
  failOnRegression?: boolean;
  json?: boolean;
  format?: string;
}

function structuredFormat(opts: DiffOpts): Format | null {
  if (opts.format) {
    if (!isFormat(opts.format)) throw new Error("--format must be json or toon");
    return opts.format;
  }
  return opts.json ? "json" : null;
}

/** Compare two CPU models: per-package and per-function self-time deltas, noise-filtered. */
export async function cpuDiffCmd(baseline: string, current: string, opts: DiffOpts): Promise<void> {
  // A run-group routes to its CPU-bearing member (breakdown preferred), so two groups compare their
  // CPU-bearing members; a plain recording/model resolves to itself.
  const [baseTarget, currentTarget] = await Promise.all([
    resolveVerbTarget(baseline, "cpu", "CPU sampling"),
    resolveVerbTarget(current, "cpu", "CPU sampling"),
  ]);
  const [baseModel, currentModel] = await Promise.all([
    loadCpuModel(baseTarget.target),
    loadCpuModel(currentTarget.target),
  ]);

  // Comparability: a cpu-diff joins per-function self-time across two models as if they measured the
  // same JS on the same lane. Warn on every capture axis that differs (to stderr, so structured
  // output stays clean), and REFUSE to gate across an incompatible browser/runtime/workload, where a
  // self-time "regression" would be an artifact of the config, not the code.
  const mismatches = comparabilityMismatches(baseModel.meta, currentModel.meta);
  if (mismatches.length) {
    console.error("\n⚠ WARNING: baseline and current were captured differently:");
    for (const mismatch of mismatches)
      console.error(`    ${mismatch.axis}: ${mismatch.base} → ${mismatch.current}`);
    console.error("  Treat this cpu-diff as directional, not a like-for-like comparison.");
  }
  // Gate on BOTH the axis membership and its `blocksGating`: the workload axis can be non-blocking
  // when an ephemeral loopback port was folded (same workload, disclosed raw ports), and a folded
  // port must not refuse a cpu-diff any more than it refuses a diff.
  const blocking = mismatches.filter(
    (mismatch) => mismatch.blocksGating && CPU_DIFF_BLOCKING_AXES.has(mismatch.axis),
  );
  if (opts.failOnRegression && blocking.length) {
    console.error(
      `\nRefusing to gate (--fail-on-regression) across an incompatible capture (` +
        `${blocking.map((mismatch) => mismatch.axis).join(", ")} differ): a self-time delta would ` +
        `reflect the capture change, not a code regression. Re-record both sides the same way to gate.`,
    );
    process.exitCode = 1;
    return;
  }

  const basePackages = new Map(packageRollup(baseModel).map((entry) => [entry.key, entry.selfMs]));
  const currentPackages = new Map(
    packageRollup(currentModel).map((entry) => [entry.key, entry.selfMs]),
  );
  const packageRows: CpuPackageDelta[] = [
    ...new Set([...basePackages.keys(), ...currentPackages.keys()]),
  ]
    .map((name) => {
      const baseMs = basePackages.get(name) ?? 0;
      const currentMs = currentPackages.get(name) ?? 0;
      return { package: name, baseMs, currentMs, delta: currentMs - baseMs };
    })
    .filter((row) => Math.abs(row.delta) >= NOISE_MS)
    .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta));

  const baseFunctions = functionsByJoinKey(baseModel.functions);
  const currentFunctions = functionsByJoinKey(currentModel.functions);
  const functionRows: CpuFunctionDelta[] = [
    ...new Set([...baseFunctions.keys(), ...currentFunctions.keys()]),
  ]
    .map((key) => {
      const baseFn = baseFunctions.get(key);
      const currentFn = currentFunctions.get(key);
      const reference = currentFn ?? baseFn!;
      const baseMs = baseFn?.selfMs ?? 0;
      const currentMs = currentFn?.selfMs ?? 0;
      return {
        fn: reference.fn,
        source: reference.source,
        file: reference.file,
        package: reference.package,
        baseMs,
        currentMs,
        delta: currentMs - baseMs,
      };
    })
    .filter((row) => Math.abs(row.delta) >= NOISE_MS)
    .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta))
    .slice(0, TOP_FUNCTIONS);

  // Gate on JS self-time (the JS-only headline), NOT the non-idle sampled total: a change that is
  // entirely gc/engine/native, or sampler-startup jitter that never lands on a JS frame, must not trip
  // a JS-cost gate. This is the axis the per-function/package movers below sum to.
  const jsSelfDelta = currentModel.jsSelfMs - baseModel.jsSelfMs;
  const jsSelfPct = baseModel.jsSelfMs > 0 ? (jsSelfDelta / baseModel.jsSelfMs) * 100 : 0;

  const fmt = structuredFormat(opts);
  if (fmt) {
    const result: CpuDiffResult = {
      baseline: { file: baseline, jsSelfMs: baseModel.jsSelfMs },
      current: { file: current, jsSelfMs: currentModel.jsSelfMs },
      noiseMs: NOISE_MS,
      netJsSelfMs: jsSelfDelta,
      netJsSelfPct: jsSelfPct,
      byPackage: packageRows,
      functions: functionRows,
    };
    console.log(serialize(result, fmt));
    if (opts.failOnRegression && jsSelfDelta > NOISE_MS) process.exitCode = 1;
    return;
  }

  const signed = (value: number) => `${value >= 0 ? "+" : ""}${num(value, 1)}`;
  console.log(
    `baseline: ${baseline}  (${num(baseModel.jsSelfMs, 1)} ms JS self-time)\ncurrent:  ${current}  (${num(currentModel.jsSelfMs, 1)} ms JS self-time)\nfilter floor: ${NOISE_MS} ms self (smaller per-function deltas are hidden). Sampling jitter runs a few % per function, so treat small deltas as noise; trust the net and the large movers.\n`,
  );
  console.log("package self-time delta:");
  console.log(
    packageRows.length
      ? table(
          ["package", "base ms", "cur ms", "delta"],
          packageRows.map((row) => [
            row.package,
            num(row.baseMs, 1),
            num(row.currentMs, 1),
            signed(row.delta),
          ]),
        )
      : "  (all packages within noise)",
  );
  console.log("\ntop function self-time deltas:");
  console.log(
    functionRows.length
      ? table(
          ["delta", "base ms", "cur ms", "package", "function (source)"],
          functionRows.map((row) => [
            signed(row.delta),
            num(row.baseMs, 1),
            num(row.currentMs, 1),
            row.package,
            `${row.fn}${row.file ? ` (${shortSource(row.file, row.source)})` : ""}`,
          ]),
        )
      : "  (all functions within noise)",
  );

  console.log(`\nnet JS self-time: ${signed(jsSelfDelta)} ms (${signed(jsSelfPct)}%)`);
  if (opts.failOnRegression && jsSelfDelta > NOISE_MS) process.exitCode = 1;
}
