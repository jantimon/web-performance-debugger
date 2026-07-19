// The one-pass capture ladder: every invocation is exactly ONE pass (one browser launch, one run of
// the flow, one recording). A rung picks WHAT that pass captures, never how many passes run.
//
// Chrome rungs:
//   default        sampler only, no trace           -> the four-slice CPU bar; no rendering counts
//   --breakdown    light trace + sampler            -> the reconciling seven-slice bar + exact counts
//   --deep         full trace (.stack + inval), OFF  -> forced-layout blame + exact counts, no bar
//   --precise-wall sampler off, no trace            -> a pristine benchmark wall, nothing else
// Firefox is one gecko pass at every rung (samples + markers are entangled at profiler startup);
// node is its own in-process lane (runtime/node.ts).
//
// [measured] constraints that shape the ladder (present-tense; docs/dev/cpu-profiling.md):
//   - The CPU sampler must NEVER ride a `.stack` trace: `disabled-by-default-devtools.timeline.stack`
//     makes Blink walk the JS stack on every Layout, and the sampler bills that to the JS frame that
//     forced the layout -- the same frame the real forced-layout cost lands on -- inflating sampled
//     self-time +21%. So the sampler rides only the light (no-`.stack`) trace (--breakdown) or no
//     trace at all (default); --deep, which needs `.stack`, runs with the sampler OFF.
//   - The fused --breakdown pass costs ~2-5% wall over sampler-only and leaves sampled self-time
//     clean (+0-1%), which is why the light trace and the sampler can share one pass.

import { traceCategories, breakdownTraceCategories, STACK_CATEGORY } from "../trace/categories.js";
import type { BrowserName } from "../browser/backend.js";
import type { BlameSemantic } from "../model/recording.js";
import type { CaptureCapabilities } from "../metrics/summarize.js";
import type { RecordOptions } from "../commands/record.js";

export type Rung = "default" | "breakdown" | "deep" | "precise-wall" | "gecko";

/** The single capture that runs for an invocation. `categories: null` means no DevTools trace. */
export interface CaptureConfig {
  /** rung name, recorded verbatim as meta.passes (a one-element array; there is no multi-pass plan) */
  rung: Rung;
  /** DevTools trace categories, or null for a trace-free pass (default rung, precise-wall, firefox) */
  categories: string[] | null;
  /** run the CPU sampler on this pass */
  cpu: boolean;
  /** keep each trace event's pid/tid so counts and the bar window to the one renderer main thread */
  keepThreadIds: boolean;
  /** Firefox: run under the Gecko profiler; the shutdown dump yields samples AND markers (blame) */
  gecko: boolean;
}

/** Pick the one capture for this invocation from the flags and backend. */
export function captureFor(opts: RecordOptions, browserName: BrowserName): CaptureConfig {
  if (browserName === "firefox") {
    // One gecko pass IS the firefox lane at every rung: samples, layout/style markers, read-site
    // blame and the reconciling bar all come from it. The rungs are reporting tiers over this one
    // capture, not capture tiers (the profiler is a startup feature for the whole browser lifetime).
    // The CLI forces the profiler on; a programmatic cpuProfile:false yields a timing-only pass,
    // which counts nothing (capabilitiesFor keys off `gecko`, and the notes say so loudly).
    const gecko = opts.cpuProfile !== false;
    return { rung: "gecko", categories: null, cpu: gecko, keepThreadIds: false, gecko };
  }
  if (opts.breakdown) {
    // Light trace (no `.stack`, no invalidationTracking) fused with the sampler: trace events and
    // samples share a clock so the seven-slice bar reconciles. keepThreadIds so the engine picks
    // the main thread. Cannot report forced counts/blame (they need `.stack`).
    return {
      rung: "breakdown",
      categories: breakdownTraceCategories(),
      cpu: true,
      keepThreadIds: true,
      gecko: false,
    };
  }
  if (opts.deep) {
    // Full trace (`.stack` + invalidationTracking) with the sampler OFF: forced-layout blame, exact
    // counts, invalidation rollup and long tasks are the product; slice durations are suppressed
    // (the `.stack` trace distorts them). No CPU model or reconciling bar -- run --breakdown for those.
    return {
      rung: "deep",
      categories: traceCategories({ invalidationTracking: true }),
      cpu: false,
      keepThreadIds: true,
      gecko: false,
    };
  }
  if (opts.preciseWall) {
    // Rung 1 minus the sampler: a pristine benchmark wall, no profiler perturbation, no counts.
    return {
      rung: "precise-wall",
      categories: null,
      cpu: false,
      keepThreadIds: false,
      gecko: false,
    };
  }
  // Default rung: the CPU sampler alone, no trace, for the cleanest wall (~1%). No rendering counts.
  return {
    rung: "default",
    categories: null,
    cpu: opts.cpuProfile !== false,
    keepThreadIds: false,
    gecko: false,
  };
}

/**
 * What the one capture that ran can observe, per rung/lane, so buildSummary gates each count/duration
 * to `Measured` null vs a number in one place (see CaptureCapabilities). The `.stack` presence is the
 * dividing line for durations: an exact `.stack`/`--deep` trace reports counts but suppresses its
 * distorted durations.
 */
/** No rendering work observed: every count/duration field reports Measured null, never 0. */
export const NO_RENDERING_CAPTURE: CaptureCapabilities = {
  counts: false,
  paintCount: false,
  longTasks: false,
  invalidations: false,
  durations: false,
  forced: false,
};

/**
 * The capabilities a recording may actually claim once the trace is parsed. A trace whose
 * wpd:run window markers are missing observed rendering work but cannot window it; counting the
 * whole trace (page load, prepare, teardown) would inflate every count, so the rendering capture
 * degrades to not-measured rather than to a wrong number.
 */
export function capabilitiesAfterParse(
  capabilities: CaptureCapabilities,
  windowFound: boolean,
): CaptureCapabilities {
  return windowFound ? capabilities : { ...NO_RENDERING_CAPTURE };
}

export function capabilitiesFor(
  config: CaptureConfig,
  browserName: BrowserName,
): CaptureCapabilities {
  if (browserName === "firefox") {
    // Layout/style counts and durations come from the Gecko Reflow/Styles markers, forced from their
    // cause stacks; paint is off-main-thread (a side track), and there is no DevTools trace for
    // invalidations or long tasks. Reported not-measured, never a fake 0 (meta.notes says so).
    return {
      counts: config.gecko,
      paintCount: false,
      longTasks: false,
      invalidations: false,
      durations: config.gecko,
      forced: config.gecko,
    };
  }
  if (config.categories == null) {
    // Default rung / precise-wall: no trace, so no rendering work is observed at all.
    return { ...NO_RENDERING_CAPTURE };
  }
  const hasStack = config.categories.includes(STACK_CATEGORY);
  return {
    counts: true,
    paintCount: true,
    longTasks: true,
    invalidations: config.rung === "deep",
    // Durations are trustworthy ONLY on the light (no-`.stack`) trace; `.stack` inflates them.
    durations: !hasStack,
    forced: hasStack,
  };
}

/**
 * What this run's forced-layout blame lines name (see BlameSemantic), a per-rung constant. Both
 * browser lanes name the READ that forced the flush (flush-site): Chrome from Blink's `.stack` on
 * `--deep`, Firefox from the sampled DOM-accessor stacks. A rung with neither produces no blame.
 */
export function blameSemanticFor(config: CaptureConfig): BlameSemantic | undefined {
  if (config.gecko) return "flush-site";
  // Flush-site blame is Blink's stack at the forced flush, which needs `.stack` -- only --deep has it.
  if (config.categories?.includes(STACK_CATEGORY)) return "flush-site";
  return undefined;
}

/**
 * Says what a run's counts are scoped to, when --iterations makes the question real (at 1 there is
 * nothing to scale). Every invocation is one pass, which runs every iteration for the wall samples,
 * so a rung that counts at all counts a TOTAL across iterations -- disclosed here rather than
 * silently rescaling `assert --max-layouts`. Null when this rung captured no counts.
 */
export function countScopeNote(
  capabilities: CaptureCapabilities,
  opts: RecordOptions,
): string | null {
  if (opts.iterations <= 1 || !capabilities.counts) return null;
  // Driver per-step counts window to the first timed iteration's trace window (labelWindows keeps
  // iteration 0), so only the overall recording's counts total. Saying "counts are totals" flatly
  // would send a reader to re-derive per-step numbers that are already right.
  const perStep = opts.driver
    ? " Per-step counts are unaffected: they describe the first timed iteration."
    : "";
  return `Counts (layout/style/paint/forced) on this recording are TOTALS across all ${opts.iterations} iterations, not one iteration's work: every invocation is one pass, which runs every iteration for the wall samples. A threshold like 'assert --max-layouts' therefore scales with --iterations. Use --iterations 1 to assert on counts.${perStep}`;
}
