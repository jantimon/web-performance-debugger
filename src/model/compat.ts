import type { RecordingMeta } from "./recording.js";

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

/**
 * Which capture axes differ between two recordings, and whether each blocks a regression gate.
 *
 * A diff subtracts fields as if the two captures measured the same thing; they do not when the axis
 * below differs. An axis `blocksGating` when a delta on it is provably the config talking, not the
 * code:
 *
 *   - browser/runtime/rung: different count provenance entirely (Gecko markers vs trace, a --deep
 *     exact count vs a --breakdown null).
 *   - workload: a different module/page/url was recorded, so the two are not the same flow.
 *   - iterations: run counts TOTAL across iterations (one pass runs every iteration), so iters 1 vs
 *     5 makes every count 5x and manufactures "regressions".
 *   - headless flavour / throttle: the frame cadence and the artificial slowdown both shift the
 *     numbers the gate reads (wall/INP floor; slice and paint cadence).
 *
 * warmup and the sampler interval only WARN: they move sampling noise and steady-state, not the
 * gated exact counts.
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
    { axis: "workload", base: base.target, current: current.target, blocksGating: true },
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
      blocksGating: false,
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
 * throttling stretches the same self-time clock. Either fabricates a self-time "regression" from
 * pure config. Rung and headless move rendering counts and the wall/INP floor, not the profiler's
 * own self-time clock, so cpu-diff only WARNS on those. */
export const CPU_DIFF_BLOCKING_AXES = new Set([
  "browser",
  "runtime",
  "workload",
  "iterations",
  "cpu-throttle",
]);
