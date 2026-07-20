import type { RecordingMeta, WorkloadIdentity } from "./recording.js";

/**
 * One capture axis that differs between two recordings being compared. `blocksGating` axes make a
 * gate (`diff --fail-on-regression`, `cpu-diff --fail-on-regression`) meaningless: the delta reflects
 * the capture config, not a code change, so gating across one would fabricate a pass/fail.
 */
import path from "node:path";

/**
 * A workload path stabilized for cross-run identity: resolved against the recording root, then
 * relative to it when it lives underneath (the same module recorded from a different cwd or via a
 * different spelling joins instead of spuriously refusing a gate). Paths outside the root stay
 * absolute; URLs never come through here.
 */
export function stableWorkloadPath(root: string, rawPath: string): string {
  const resolved = path.resolve(root, rawPath);
  const relative = path.relative(root, resolved);
  return relative && !relative.startsWith("..") ? relative : resolved;
}

export interface CompatMismatch {
  axis: string;
  base: string;
  current: string;
  blocksGating: boolean;
}

/** The one rung this recording captured, as a stable string (passes are single-element today, but
 * sort+join keeps an older multi-pass recording comparing deterministically). */
function rungOf(meta: RecordingMeta): string {
  return [...(meta.passes ?? [])].sort().join("+");
}

/** Headless frame cadence, which sets the wall/INP floor: "headed" | "shell" (~120Hz) | "new"
 * (~60Hz). See docs/dev/frame-floor.md. */
function headlessFlavour(meta: RecordingMeta): string {
  if (meta.headless === false) return "headed";
  return meta.headlessMode ?? "shell";
}

function throttleOf(meta: RecordingMeta): string {
  return meta.throttle?.cpuRate ? `${meta.throttle.cpuRate}x` : "off";
}

/** One line naming lane + host + module, so two flows differ here whenever any of the three does. A
 * real value is quoted (JSON.stringify), a null one is the bare word `null`, so a host page or module
 * literally named "null" cannot read as absent and collide with a blank-page run. */
function workloadCanonical(identity: WorkloadIdentity): string {
  const host = identity.host === null ? "null" : JSON.stringify(identity.host);
  const workloadModule = identity.module === null ? "null" : JSON.stringify(identity.module);
  return `${identity.lane} host=${host} module=${workloadModule}`;
}

/**
 * The workload axis: does the same flow run on both sides?
 *
 *   - both carry a structured `workload` -> compare it; a different lane/host/module blocks the gate
 *     (subtracting two programs is not a code delta).
 *   - neither does (both predate the field) -> fall back to the `target` string, as before.
 *   - one does, one does not -> the older side carries no module identity when a host page was
 *     present, so the flow cannot be verified. WARN under a distinct axis name rather than block:
 *     refusing every gate against a pre-upgrade baseline would be heavier than the risk, but the
 *     reader must know the sameness is unverified.
 */
function workloadMismatch(base: RecordingMeta, current: RecordingMeta): CompatMismatch {
  if (base.workload && current.workload)
    return {
      axis: "workload",
      base: workloadCanonical(base.workload),
      current: workloadCanonical(current.workload),
      blocksGating: true,
    };
  if (!base.workload && !current.workload)
    return { axis: "workload", base: base.target, current: current.target, blocksGating: true };
  return {
    axis: "workload-identity",
    base: base.workload ? workloadCanonical(base.workload) : `pre-identity(${base.target})`,
    current: current.workload
      ? workloadCanonical(current.workload)
      : `pre-identity(${current.target})`,
    blocksGating: false,
  };
}

/**
 * Which capture axes differ between two recordings, and whether each blocks a regression gate.
 *
 * A diff subtracts fields as if the two captures measured the same thing; they do not when the axis
 * below differs. An axis `blocksGating` when a delta on it is provably the config talking, not the
 * code:
 *
 *   - browser/runtime/rung: different count provenance entirely (Gecko markers vs trace, a --deep
 *     exact count vs a --breakdown null).
 *   - workload: a different lane, host page, or module was recorded (workloadMismatch), so the two
 *     are not the same flow. A mixed pair (one side predates the structured identity) warns under
 *     "workload-identity" instead of blocking, since its sameness cannot be verified either way.
 *   - iterations: run counts TOTAL across iterations (one pass runs every iteration), so iters 1 vs
 *     5 makes every count 5x and manufactures "regressions".
 *   - headless flavour / throttle: the frame cadence and the artificial slowdown both shift the
 *     numbers the gate reads (wall/INP floor; slice and paint cadence).
 *   - warmup: the untimed runs before the timed window carry workload state (cache priming, JIT
 *     tiers, lazy CSS, memoization, first-render code). Moving a call across that boundary changes
 *     which counts land in the timed window, so a first-call layout can read as 0 -> 1 from a
 *     `--warmup` change alone. It is workload state, not sampling noise, so it blocks the gate.
 *
 * The sampler interval only WARNS: it moves sampling density and steady-state, not the gated exact
 * counts.
 */
export function comparabilityMismatches(
  base: RecordingMeta,
  current: RecordingMeta,
): CompatMismatch[] {
  const axes: CompatMismatch[] = [
    {
      axis: "browser",
      base: base.browser ?? "chrome",
      current: current.browser ?? "chrome",
      blocksGating: true,
    },
    {
      axis: "runtime",
      base: base.runtime ?? "chrome",
      current: current.runtime ?? "chrome",
      blocksGating: true,
    },
    { axis: "rung", base: rungOf(base), current: rungOf(current), blocksGating: true },
    workloadMismatch(base, current),
    {
      axis: "iterations",
      base: String(base.iterations ?? "?"),
      current: String(current.iterations ?? "?"),
      blocksGating: true,
    },
    {
      axis: "headless",
      base: headlessFlavour(base),
      current: headlessFlavour(current),
      blocksGating: true,
    },
    {
      axis: "cpu-throttle",
      base: throttleOf(base),
      current: throttleOf(current),
      blocksGating: true,
    },
    {
      axis: "warmup",
      base: String(base.warmup ?? "?"),
      current: String(current.warmup ?? "?"),
      blocksGating: true,
    },
    {
      axis: "sampler-interval",
      base: base.cpuIntervalUs != null ? `${base.cpuIntervalUs}us` : "?",
      current: current.cpuIntervalUs != null ? `${current.cpuIntervalUs}us` : "?",
      blocksGating: false,
    },
  ];
  return axes.filter((entry) => entry.base !== entry.current);
}

/** The axes that make a `cpu-diff --fail-on-regression` gate meaningless: a JS self-time delta is
 * config, not code, when they differ. Lane (browser/runtime) and workload change WHAT is sampled;
 * `iterations` and `cpu-throttle` change its SCALE. CPU self-time totals across every sampled
 * iteration (one pass runs them all), so iters 1 vs 4 roughly quadruples the summed ms; CPU
 * throttling stretches the same self-time clock. `warmup` moves the workload's first-call state
 * (JIT tiers, caches, first-render code) into or out of the timed window, so an expensive first call
 * lands in the samples under `--warmup 0` and not under `--warmup 1` though the code is identical.
 * Each fabricates a self-time "regression" from pure config. Rung and headless move rendering counts
 * and the wall/INP floor, not the profiler's own self-time clock, so cpu-diff only WARNS on those. */
export const CPU_DIFF_BLOCKING_AXES = new Set([
  "browser",
  "runtime",
  "workload",
  "iterations",
  "warmup",
  "cpu-throttle",
]);
