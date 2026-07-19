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
  const [baseModel, currentModel] = await Promise.all([
    loadCpuModel(baseline),
    loadCpuModel(current),
  ]);

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

  const scriptingDelta = currentModel.scriptingMs - baseModel.scriptingMs;
  const scriptingPct =
    baseModel.scriptingMs > 0 ? (scriptingDelta / baseModel.scriptingMs) * 100 : 0;

  const fmt = structuredFormat(opts);
  if (fmt) {
    const result: CpuDiffResult = {
      baseline: { file: baseline, scriptingMs: baseModel.scriptingMs },
      current: { file: current, scriptingMs: currentModel.scriptingMs },
      noiseMs: NOISE_MS,
      netScriptingMs: scriptingDelta,
      netScriptingPct: scriptingPct,
      byPackage: packageRows,
      functions: functionRows,
    };
    console.log(serialize(result, fmt));
    if (opts.failOnRegression && scriptingDelta > NOISE_MS) process.exitCode = 1;
    return;
  }

  const signed = (value: number) => `${value >= 0 ? "+" : ""}${num(value, 1)}`;
  console.log(
    `baseline: ${baseline}  (${num(baseModel.scriptingMs, 1)} ms JS self-time)\ncurrent:  ${current}  (${num(currentModel.scriptingMs, 1)} ms JS self-time)\nfilter floor: ${NOISE_MS} ms self (smaller per-function deltas are hidden). Sampling jitter runs a few % per function, so treat small deltas as noise; trust the net and the large movers.\n`,
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

  console.log(`\nnet scripting: ${signed(scriptingDelta)} ms (${signed(scriptingPct)}%)`);
  if (opts.failOnRegression && scriptingDelta > NOISE_MS) process.exitCode = 1;
}
