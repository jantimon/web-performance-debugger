import type { AllocDiffResult, AllocPackageDelta, AllocFunctionDelta } from "../model/query.js";
import type { AllocFunction } from "../model/recording.js";
import { num, table } from "../output/ascii.js";
import { serialize, structuredFormat, type StructuredOutOpts } from "../output/format.js";
import { loadAllocModel, packageAllocRollup } from "../profile/allocprofile.js";
import { shortSource } from "../profile/cpuprofile.js";
import { comparabilityMismatches } from "../model/compat.js";

const MB = 1024 * 1024;

/** Per-package/per-function rows whose byte delta is below this are hidden as sampling noise. A DISPLAY
 * filter for the movers table, NOT the gate (the gate floor scales with the workload, see below) */
const NOISE_BYTES = 0.25 * MB;
const TOP_FUNCTIONS = 25;

/**
 * The allocation gate floor scales with the workload, the same two-term shape the cpu-diff gate uses:
 * the net allocated bytes must clear `max(--noise-floor MB, --noise-pct% of the baseline)`, default
 * `max(1 MB, 25%)`. Heap sampling is a Poisson estimator, so the absolute byte TOTAL is directional,
 * not exact ([measured, --target node --alloc] the run-to-run net on byte-identical code is ~15-20%
 * relative: p95 15%, max 20% on a ~14 MB workload). The percentage term sits above that noise ceiling
 * so byte-identical code gates green, while a real allocation regression (the +50% probe reads +33..78%,
 * a needless per-row array) clears it. The absolute term keeps a tiny-allocation workload from gating
 * on a fraction of a megabyte. Both terms are user-settable (--noise-floor, --noise-pct).
 * See docs/dev/allocation-profiling.md
 */
const DEFAULT_ALLOC_FLOOR_MB = 1;
const DEFAULT_ALLOC_NOISE_PCT = 25;

/** The alloc cross-run join key: name + bare file (falling back to the package), so a line shift does
 * not split the join. Mirrors cpuprofile's functionJoinKey, on the byte-weighted AllocFunction */
function allocJoinKey(fn: AllocFunction): string {
  return `${fn.fn} ${fn.file ?? fn.package}`;
}

/** Index a model's functions by join key, SUMMING self bytes on a collision (same name+file at two
 * lines), so a row reflects the whole line rather than dropping one silently. The first entry is
 * copied, so the loaded model is never mutated */
function functionsByJoinKey(functions: AllocFunction[]): Map<string, AllocFunction> {
  const byKey = new Map<string, AllocFunction>();
  for (const fn of functions) {
    const key = allocJoinKey(fn);
    const existing = byKey.get(key);
    if (existing) existing.selfBytes += fn.selfBytes;
    else byKey.set(key, { ...fn });
  }
  return byKey;
}

interface DiffOpts extends StructuredOutOpts {
  /** exit 1 when the net allocated bytes clear the gate floor (a regression); off = report only */
  failOnRegression?: boolean;
  /** absolute floor term (MB), --noise-floor; defaults to DEFAULT_ALLOC_FLOOR_MB */
  noiseFloorMb?: number;
  /** relative floor term (percent of the baseline total), --noise-pct; defaults to DEFAULT_ALLOC_NOISE_PCT */
  noisePct?: number;
}

/** Compact bytes as "12.3 MB" / "456.0 KB" / "789 B" */
function fmtBytes(bytes: number): string {
  const abs = Math.abs(bytes);
  if (abs >= MB) return `${num(bytes / MB, 1)} MB`;
  if (abs >= 1024) return `${num(bytes / 1024, 1)} KB`;
  return `${Math.round(bytes)} B`;
}

/** Compare two allocation models: per-package and per-function self-byte deltas plus the net total,
 * noise-filtered. The gated axis is the net total allocated bytes (the allocation analog of cpu-diff's
 * net JS self-time) */
export async function allocDiffCmd(
  baseline: string,
  current: string,
  opts: DiffOpts,
): Promise<void> {
  const [baseModel, currentModel] = await Promise.all([
    loadAllocModel(baseline),
    loadAllocModel(current),
  ]);

  // Comparability: an alloc-diff joins per-function self bytes across two models as if they measured
  // the same workload on the same lane. Warn on every capture axis that differs (to stderr, so
  // structured output stays clean), and REFUSE to gate across an incompatible workload/lane/capture
  // mode, where a byte "regression" would be an artifact of the config, not the code
  const mismatches = comparabilityMismatches(baseModel.meta, currentModel.meta);
  if (mismatches.length) {
    console.error("\n⚠ WARNING: baseline and current were captured differently:");
    for (const mismatch of mismatches)
      console.error(`    ${mismatch.axis}: ${mismatch.base} → ${mismatch.current}`);
    console.error("  Treat this alloc-diff as directional, not a like-for-like comparison.");
  }
  const blocking = mismatches.filter(
    (mismatch) => mismatch.blocksGating && ALLOC_DIFF_BLOCKING_AXES.has(mismatch.axis),
  );
  if (opts.failOnRegression && blocking.length) {
    console.error(
      `\nRefusing to gate (--fail-on-regression) across an incompatible capture (` +
        `${blocking.map((mismatch) => mismatch.axis).join(", ")} differ): a byte delta would reflect ` +
        `the capture change, not a code regression. Re-record both sides the same way to gate.`,
    );
    process.exitCode = 1;
    return;
  }

  const basePackages = new Map(
    packageAllocRollup(baseModel).map((entry) => [entry.key, entry.selfBytes]),
  );
  const currentPackages = new Map(
    packageAllocRollup(currentModel).map((entry) => [entry.key, entry.selfBytes]),
  );
  const packageRows: AllocPackageDelta[] = [
    ...new Set([...basePackages.keys(), ...currentPackages.keys()]),
  ]
    .map((name) => {
      const baseBytes = basePackages.get(name) ?? 0;
      const currentBytes = currentPackages.get(name) ?? 0;
      return { package: name, baseBytes, currentBytes, delta: currentBytes - baseBytes };
    })
    .filter((row) => Math.abs(row.delta) >= NOISE_BYTES)
    .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta));

  const baseFunctions = functionsByJoinKey(baseModel.functions);
  const currentFunctions = functionsByJoinKey(currentModel.functions);
  const functionRows: AllocFunctionDelta[] = [
    ...new Set([...baseFunctions.keys(), ...currentFunctions.keys()]),
  ]
    .map((key) => {
      const baseFn = baseFunctions.get(key);
      const currentFn = currentFunctions.get(key);
      const reference = currentFn ?? baseFn!;
      const baseBytes = baseFn?.selfBytes ?? 0;
      const currentBytes = currentFn?.selfBytes ?? 0;
      return {
        fn: reference.fn,
        source: reference.source,
        file: reference.file,
        package: reference.package,
        baseBytes,
        currentBytes,
        delta: currentBytes - baseBytes,
      };
    })
    .filter((row) => Math.abs(row.delta) >= NOISE_BYTES)
    .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta))
    .slice(0, TOP_FUNCTIONS);

  // Gate on the net TOTAL allocated bytes: the allocation analog of cpu-diff's net JS self-time. The
  // per-package/per-function movers below explain WHERE the bytes moved, but the total is the axis
  const netBytes = currentModel.totalBytes - baseModel.totalBytes;
  const netPct = baseModel.totalBytes > 0 ? (netBytes / baseModel.totalBytes) * 100 : 0;

  // The gate floor scales with the workload: `max(absolute MB, pct% of the baseline)`. The percentage
  // term absorbs the ~15-20% sampling jitter of the absolute byte total; the absolute term keeps a
  // tiny-allocation workload from gating on a fraction of a megabyte
  const noiseFloorBytes = (opts.noiseFloorMb ?? DEFAULT_ALLOC_FLOOR_MB) * MB;
  const noisePct = opts.noisePct ?? DEFAULT_ALLOC_NOISE_PCT;
  const gateFloorBytes = Math.max(noiseFloorBytes, (noisePct / 100) * baseModel.totalBytes);
  const gateFires = netBytes > gateFloorBytes;

  const fmt = structuredFormat(opts);
  if (fmt) {
    const result: AllocDiffResult = {
      baseline: { file: baseline, totalBytes: baseModel.totalBytes },
      current: { file: current, totalBytes: currentModel.totalBytes },
      noiseBytes: NOISE_BYTES,
      noisePct,
      gateFloorBytes,
      netBytes,
      netPct,
      byPackage: packageRows,
      functions: functionRows,
      notes: [],
    };
    console.log(serialize(result, fmt));
    if (opts.failOnRegression && gateFires) process.exitCode = 1;
    return;
  }

  const signed = (bytes: number) => `${bytes >= 0 ? "+" : ""}${fmtBytes(bytes)}`;
  console.log(
    `baseline: ${baseline}  (${fmtBytes(baseModel.totalBytes)} allocated)\n` +
      `current:  ${current}  (${fmtBytes(currentModel.totalBytes)} allocated)\n` +
      `filter floor: ${fmtBytes(NOISE_BYTES)} (smaller per-function deltas are hidden). Allocated bytes are sampled and directional (~10-20%); trust the net and the large movers.\n`,
  );
  if (opts.failOnRegression)
    console.log(
      `gate floor: net > ${fmtBytes(gateFloorBytes)} to regress (max of ${num(opts.noiseFloorMb ?? DEFAULT_ALLOC_FLOOR_MB, 1)} MB and ${num(noisePct, 0)}% of baseline; --noise-floor / --noise-pct to change).\n`,
    );
  console.log("package allocation delta:");
  console.log(
    packageRows.length
      ? table(
          ["package", "base", "cur", "delta"],
          packageRows.map((row) => [
            row.package,
            fmtBytes(row.baseBytes),
            fmtBytes(row.currentBytes),
            signed(row.delta),
          ]),
        )
      : "  (all packages within noise)",
  );
  console.log("\ntop function allocation deltas:");
  console.log(
    functionRows.length
      ? table(
          ["delta", "base", "cur", "package", "function (source)"],
          functionRows.map((row) => [
            signed(row.delta),
            fmtBytes(row.baseBytes),
            fmtBytes(row.currentBytes),
            row.package,
            `${row.fn}${row.file ? ` (${shortSource(row.file, row.source)})` : ""}`,
          ]),
        )
      : "  (all functions within noise)",
  );

  console.log(
    `\nnet allocation: ${signed(netBytes)} (${netPct >= 0 ? "+" : ""}${num(netPct, 1)}%)`,
  );
  if (opts.failOnRegression && gateFires) process.exitCode = 1;
}

/** The axes that make an alloc-diff --fail-on-regression gate meaningless: a byte delta is config, not
 * code, when they differ. A different lane/workload changes WHAT is sampled; iterations/warmup change
 * its SCALE; the capture mode must be node-alloc on both sides (a non-alloc model never loads here, but
 * gate on it anyway so the refusal is explicit) */
const ALLOC_DIFF_BLOCKING_AXES = new Set([
  "browser",
  "runtime",
  "workload",
  "iterations",
  "warmup",
  "variant",
  "capture-mode",
]);
