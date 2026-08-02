import type { CpuDiffResult, CpuFunctionDelta, CpuPackageDelta } from "../model/query.js";
import type { CpuFunction, CpuModel } from "../model/recording.js";
import { usToMs } from "../model/time.js";
import { num, table } from "../output/ascii.js";
import { serialize, structuredFormat, type StructuredOutOpts } from "../output/format.js";
import {
  packageRollup,
  functionJoinKey,
  loadCpuModel,
  shortSource,
  DEFAULT_CPU_INTERVAL_US,
} from "../profile/cpuprofile.js";
import { comparabilityMismatches, CPU_DIFF_BLOCKING_AXES } from "../model/compat.js";
import { resolveVerbTarget } from "./group.js";

/** Per-function/package rows whose delta is below this (ms) are hidden as sampling noise. A DISPLAY
 * filter for the movers table, NOT the gate: the gate floor scales with the workload (see below) */
const NOISE_MS = 0.5;
const TOP_FUNCTIONS = 25;

/**
 * The regression gate's noise floor has TWO terms and trips only when the net JS self-time delta
 * clears BOTH: `max(absoluteMs, pct% of the baseline)`. Sampling jitter scales with the workload, so a
 * fixed absolute floor cannot fit every size at once. [measured, --target node] the run-to-run net
 * delta on byte-identical code is ~0.5ms absolute / ~11% relative at a ~5ms workload (18 samples), and
 * ~6ms absolute / ~3% relative at a ~220ms workload (--iterations 20): absolute jitter GROWS with
 * self-time while relative jitter SHRINKS. A fixed 0.5ms floor false-reds ~2% of identical pairs at
 * 5ms but ~40% at 220ms (more --iterations sums more self-time, so the absolute net-noise grows past
 * a fixed floor). The percentage term tracks the absolute jitter as it grows; the absolute term keeps
 * a small-workload delta (or a 0ms baseline) from gating on a fraction of a millisecond.
 *
 * The default 15% sits above the worst measured identical-pair relative jitter (~11% at 5ms, the
 * noisiest size above the resolving floor) with margin, so byte-identical code passes >=95% of runs at
 * every iteration count, while a real 30% regression on a 5ms workload (+1.5ms) still clears the 15%
 * floor (0.75ms) by 2x. Both terms are user-settable (--noise-floor, --noise-pct) for a team on a
 * noisier host or one that wants a tighter gate on a large stable workload. See docs/dev/cpu-profiling.md
 */
const DEFAULT_GATE_FLOOR_MS = 0.5;
const DEFAULT_NOISE_PCT = 15;

/**
 * The sampler's resolving power, in samples. Below this many samples of JS self-time on BOTH sides, a
 * net delta is quantization, not signal, so the JS-self gate does not fire. At the 200us default
 * interval that is ~2ms, while the 0.5ms absolute floor term is ~2.5 samples: two identical near-zero
 * runs can jitter their net delta wider than that floor purely from where the samples landed (measured
 * jitter 0.16-1.21ms on a near-zero probe). "Two identical runs must gate green" is the promise, so below
 * resolving power the gate reports the delta as not evaluable rather than fabricating a regression.
 * Derived from the interval so it scales if the interval changes. See docs/dev/cpu-profiling.md
 */
const RESOLVING_FLOOR_SAMPLES = 10;

/** ms of JS self-time below which a model's sampler cannot resolve signal from quantization */
function resolvingFloorMs(model: CpuModel): number {
  const intervalUs = model.sampleIntervalUs > 0 ? model.sampleIntervalUs : DEFAULT_CPU_INTERVAL_US;
  return usToMs(RESOLVING_FLOOR_SAMPLES * intervalUs);
}

/**
 * Index a model's functions by their cross-run join key, SUMMING self/total time on a collision. Two
 * functions can share a key (same name in the same file: overloads, or a name reused at two lines --
 * `functionJoinKey` joins on the bare file, not the line, so a line shift does not split the join).
 * A plain `new Map(...)` would keep only the last, silently dropping the other's self-time from the
 * delta; summing makes the row reflect the whole line. The first entry is copied so the loaded model
 * is never mutated
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

interface DiffOpts extends StructuredOutOpts {
  /** exit 1 when the net JS self-time clears the gate floor (a regression); off = report only */
  failOnRegression?: boolean;
  /** absolute floor term (ms), --noise-floor; defaults to DEFAULT_GATE_FLOOR_MS */
  noiseFloorMs?: number;
  /** relative floor term (percent of baseline), --noise-pct; defaults to DEFAULT_NOISE_PCT */
  noisePct?: number;
}

/** Compare two CPU models: per-package and per-function self-time deltas, noise-filtered */
export async function cpuDiffCmd(baseline: string, current: string, opts: DiffOpts): Promise<void> {
  // A run-group routes to its CPU-bearing member (breakdown preferred), so two groups compare their
  // CPU-bearing members; a plain recording/model resolves to itself
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
  // self-time "regression" would be an artifact of the config, not the code
  const mismatches = comparabilityMismatches(baseModel.meta, currentModel.meta);
  if (mismatches.length) {
    console.error("\n⚠ WARNING: baseline and current were captured differently:");
    for (const mismatch of mismatches)
      console.error(`    ${mismatch.axis}: ${mismatch.base} → ${mismatch.current}`);
    console.error("  Treat this cpu-diff as directional, not a like-for-like comparison.");
  }
  // Gate on BOTH the axis membership and its `blocksGating`: the workload axis can be non-blocking
  // when an ephemeral loopback port was folded (same workload, disclosed raw ports), and a folded
  // port must not refuse a cpu-diff any more than it refuses a diff
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
  // a JS-cost gate. This is the axis the per-function/package movers below sum to
  const jsSelfDelta = currentModel.jsSelfMs - baseModel.jsSelfMs;
  const jsSelfPct = baseModel.jsSelfMs > 0 ? (jsSelfDelta / baseModel.jsSelfMs) * 100 : 0;

  // Below the sampler's resolving power a net delta is quantization, not signal: when BOTH sides'
  // jsSelfMs sit under RESOLVING_FLOOR_SAMPLES samples, the JS-self gate is not evaluable and does not
  // fire whatever the net delta, and the output discloses it. The two recordings can carry different
  // intervals (chrome default 200us vs the ~150us breakdown stream vs firefox ~1ms), so the larger
  // implied floor wins. Other gated axes are unaffected
  const floorMs = Math.max(resolvingFloorMs(baseModel), resolvingFloorMs(currentModel));
  const belowResolvingFloor = baseModel.jsSelfMs < floorMs && currentModel.jsSelfMs < floorMs;
  const resolvingFloorNote = belowResolvingFloor
    ? `both sides below the sampler's resolving floor (~${num(floorMs, 1)}ms at the recorded interval); ` +
      `the JS-self net gate is not evaluable at this scale`
    : undefined;

  // The gate floor scales with the workload: `max(absolute ms, pct% of the baseline)`. The percentage
  // term absorbs the sampling jitter that grows with self-time (so more --iterations does not manufacture
  // a regression); the absolute term keeps a small or 0ms baseline from gating on a fraction of a
  // sample. Above the resolving floor, a net delta over this floor is the regression the gate fires on
  const noiseFloorMs = opts.noiseFloorMs ?? DEFAULT_GATE_FLOOR_MS;
  const noisePct = opts.noisePct ?? DEFAULT_NOISE_PCT;
  const gateFloorMs = Math.max(noiseFloorMs, (noisePct / 100) * baseModel.jsSelfMs);
  const jsSelfGateFires = jsSelfDelta > gateFloorMs && !belowResolvingFloor;

  const fmt = structuredFormat(opts);
  if (fmt) {
    const result: CpuDiffResult = {
      baseline: { file: baseline, jsSelfMs: baseModel.jsSelfMs },
      current: { file: current, jsSelfMs: currentModel.jsSelfMs },
      noiseMs: NOISE_MS,
      noisePct,
      gateFloorMs,
      netJsSelfMs: jsSelfDelta,
      netJsSelfPct: jsSelfPct,
      byPackage: packageRows,
      functions: functionRows,
      notes: resolvingFloorNote ? [resolvingFloorNote] : [],
    };
    console.log(serialize(result, fmt));
    if (opts.failOnRegression && jsSelfGateFires) process.exitCode = 1;
    return;
  }

  const signed = (value: number) => `${value >= 0 ? "+" : ""}${num(value, 1)}`;
  console.log(
    `baseline: ${baseline}  (${num(baseModel.jsSelfMs, 1)} ms JS self-time)\ncurrent:  ${current}  (${num(currentModel.jsSelfMs, 1)} ms JS self-time)\nfilter floor: ${NOISE_MS} ms self (smaller per-function deltas are hidden). Sampling jitter runs a few % per function, so treat small deltas as noise; trust the net and the large movers.\n`,
  );
  if (opts.failOnRegression)
    console.log(
      `gate floor: net > ${num(gateFloorMs, 1)} ms to regress (max of ${num(noiseFloorMs, 1)} ms and ${num(noisePct, 0)}% of baseline; --noise-floor / --noise-pct to change).\n`,
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
  if (resolvingFloorNote) console.log(`note: ${resolvingFloorNote}`);
  if (opts.failOnRegression && jsSelfGateFires) process.exitCode = 1;
}
