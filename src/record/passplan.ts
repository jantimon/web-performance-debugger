// The two-pass counts-vs-wall machinery: the PassSpec shape, the pass-plan builder, and the two
// notes that describe what a plan's counts and blame are scoped to. This whole file is the
// isolation model that keeps counts (one iteration's work) apart from wall (a bulk statistic), and
// is expected to be deleted wholesale by the planned single-pass span rewrite -- so keep the
// counts-vs-wall reasoning here, not scattered into the orchestrator.

import { traceCategories, breakdownTraceCategories } from "../trace/categories.js";
import type { BrowserCaps, BrowserName } from "../browser/backend.js";
import type { BlameSemantic } from "../model/recording.js";
import type { RecordOptions } from "../commands/record.js";

export interface PassSpec {
  name: string;
  /** null = run with tracing OFF (clean timing) */
  categories: string[] | null;
  /** capture a CPU sampling profile during this pass (tracing stays off) */
  cpu?: boolean;
  /**
   * Keep each trace event's pid/tid (parseTrace drops them otherwise). Only the --breakdown pass
   * sets this: the seven-slice engine tiles the renderer main thread and must tell it from
   * raster/compositor threads. Off elsewhere, so those recordings' events stay byte-for-byte.
   */
  keepThreadIds?: boolean;
  /** Firefox: run under the Gecko profiler; the shutdown dump yields CPU samples AND
   * layout/style markers (blame) from this one pass. */
  gecko?: boolean;
  /**
   * bench: timed iterations this pass runs, overriding --iterations. The trace pass runs 1
   * because its numbers are counts, which describe one iteration's work and must not scale with
   * --iterations; the timing pass runs them all because its numbers are wall samples, which only
   * mean something in bulk. Unset => --iterations.
   */
  iterations?: number;
  /**
   * bench: close the CDP counter bracket after the first timed iteration instead of around the
   * whole loop. Only for a pass that runs every iteration for wall yet whose counters should
   * describe one (the timing pass). A pass that is ALSO the only count source must not set this:
   * its trace-derived counts cover every iteration, so per-iteration CDP counts beside them put
   * two different windows in one summary (measured under --no-isolate: layoutCount 22 from one
   * iteration next to forcedLayoutCount 323 from eight).
   */
  bracketFirstIteration?: boolean;
}

/**
 * Build the pass plan for a run from its options and backend. Each branch keeps counts (one
 * iteration's work) and wall (a bulk statistic) on their own passes wherever possible; the notes
 * below disclose the lanes where that separation cannot hold.
 */
export function buildPassSpecs(opts: RecordOptions, browserName: BrowserName): PassSpec[] {
  // Pass isolation: heavy invalidationTracking distorts timing, so measure timing
  // in a tracing-free pass and the paint/invalidation detail in a separate pass.
  const wantTrace = opts.trace !== false;
  const traceCats = traceCategories({ invalidationTracking: opts.invalidationTracking !== false });
  const traceSpec: PassSpec = { name: "trace", categories: traceCats };
  // The sampler rides the timing pass rather than a pass of its own: both specs are
  // `categories: null`, so a separate cpu pass would differ from the timing pass only by the
  // sampler and would buy isolation from the *timing* pass, which is not what matters.
  // What matters is isolation from TRACING. NEVER move `cpu` onto traceSpec: sampling there
  // inflates CPU self-time +21% with non-overlapping ranges, because `devtools.timeline.stack`
  // makes Blink walk the JS stack on every Layout and the sampler bills that work to the JS frame
  // that forced it -- landing on the same frame as the real forced-layout cost, so the two are
  // indistinguishable after the fact. Riding the timing pass costs ~10% on wall (already the
  // directional signal), which --no-cpu-profile buys back. Measurements: docs/dev/cpu-profiling.md.
  const timingSpec: PassSpec = {
    name: "timing",
    categories: null,
    cpu: opts.cpuProfile,
    bracketFirstIteration: true,
  };
  // --breakdown fuses a light trace (no `.stack`, no invalidationTracking) with the CPU sampler in
  // ONE pass, so trace events and samples share a clock and the seven-slice breakdown reconciles.
  // [measured] the light trace leaves self-time clean (+0-1%) and costs ~2-5% wall (probes A-C).
  // It carries wall AND counts like --no-isolate, so it does NOT bracket the first iteration (that
  // would put one iteration's CDP counts beside the whole-window trace counts); noteCountScope
  // includes the "breakdown" pass in its totalling set, so it discloses that counts total across
  // --iterations. keepThreadIds so the engine can pick the main thread.
  const breakdownSpec: PassSpec = {
    name: "breakdown",
    categories: breakdownTraceCategories(),
    cpu: true,
    keepThreadIds: true,
  };
  // --no-trace skips the heavy trace pass entirely: counts come from CDP (timing
  // pass) and optionally a CPU profile, with no paint/forced/invalidation detail.
  // The fallback for pages whose invalidationTracking pass pins the main thread.
  if (opts.breakdown) {
    // Chrome-only single pass (the CLI rejects firefox/node and the contradictory isolation flags).
    return [breakdownSpec];
  }
  if (browserName === "firefox") {
    // Firefox has no CDP trace/counters: a clean timing pass, plus one
    // Gecko-profiler pass that yields CPU samples AND layout/style markers (blame) together.
    // The gecko pass keeps --iterations (unlike Chrome's trace pass, pinned to 1 below): it is
    // also the only CPU sampler on this lane, and one iteration would starve it of samples.
    // Counts therefore still scale with --iterations here; noteCountScope says so.
    const specs = [timingSpec];
    if (opts.cpuProfile) specs.push({ name: "gecko", categories: null, gecko: true });
    return specs;
  }
  // No cpu pass: the sampler rides timingSpec (see the note there).
  // The trace pass is pinned to one iteration ONLY when a timing pass exists to carry the wall
  // samples. Under --no-isolate it is the only pass, so it has to run them all, and its counts
  // scale with --iterations again (disclosed, not silently wrong).
  return opts.isolate
    ? wantTrace
      ? [timingSpec, { ...traceSpec, iterations: 1 }]
      : [timingSpec]
    : wantTrace
      ? [traceSpec]
      : [timingSpec];
}

/**
 * Says what a run's counts are scoped to, when --iterations makes the question real (at 1 there is
 * nothing to scale). Applies to both modes: --iterations repeats run() in either.
 *
 * Counts answer "how much work does one iteration cause"; wall answers "how long does it take",
 * which needs repetition. Summing counts over --iterations conflates the two and silently rescales
 * every threshold: `assert --max-layouts 30` would pass at --iterations 1 and fail at 10 on the
 * same page (measured: layoutCount 22 -> 102 -> 202 at 1/5/10). The pass plan keeps them apart, and
 * the lanes that cannot say so here.
 */
export function noteCountScope(
  specs: PassSpec[],
  opts: RecordOptions,
  caps: BrowserCaps,
): string | null {
  if (opts.iterations <= 1) return null;
  const tracePass = specs.find((spec) => spec.name === "trace");
  const geckoPass = specs.find((spec) => spec.name === "gecko");
  const breakdownPass = specs.find((spec) => spec.name === "breakdown");
  // --no-isolate: one pass carries wall AND counts, so it must run every iteration and its counts
  // are totals. Gecko: that pass is also the lane's only CPU sampler, and pinning it to one
  // iteration would starve the profile of samples, which costs more than the counts gain.
  // --breakdown: one fused pass (light trace + sampler) is the only pass, so it too carries wall AND
  // counts, runs every iteration, and its counts total.
  const totalling = (tracePass && tracePass.iterations !== 1) || geckoPass || breakdownPass;
  if (totalling) {
    const why = geckoPass
      ? "the Gecko pass is also this lane's CPU sampler, so it runs every iteration"
      : breakdownPass
        ? "--breakdown fuses the light trace and CPU sampler into one pass, which must run every iteration for the wall samples"
        : "--no-isolate collapses to one pass, which must run every iteration for the wall samples";
    // Driver per-step counts are unaffected: each measureStep brackets its own counters and
    // mergeSteps keeps the first iteration's, so only THIS recording's overall counts total up.
    // Saying "counts are totals" flatly would send a reader to re-derive per-step numbers that
    // are already right.
    const perStep = opts.driver
      ? " Per-step counts are unaffected: they describe the first timed iteration."
      : "";
    return `Counts (layout/style/paint/forced) on this recording are TOTALS across all ${opts.iterations} iterations, not one iteration's work: ${why}. A threshold like 'assert --max-layouts' therefore scales with --iterations. Use --iterations 1 to assert on counts.${perStep}`;
  }
  // Name only the mechanisms that actually ran: under --no-trace there is no trace pass, and
  // claiming one "runs a single iteration" would describe a pass that does not exist. The caps
  // gate is not redundant with bracketFirstIteration: runPass also requires cdpCounts to split,
  // so reading the spec alone would promise a CDP bracket on Firefox, where there are no CDP
  // counters and the note two lines up says every count is 0.
  const how: string[] = [];
  if (caps.cdpCounts && specs.some((spec) => spec.bracketFirstIteration))
    how.push("the CDP counters bracket the first iteration");
  if (tracePass?.iterations === 1) how.push("the trace pass runs a single iteration");
  if (!how.length) return null;
  return `Counts describe the FIRST timed iteration, not all ${opts.iterations} (${how.join("; ")}), so they mean the same at any --iterations. Wall/stats still come from all ${opts.iterations}.`;
}

/**
 * What this run's forced-layout blame lines name, read off the pass plan that actually ran rather
 * than the browser name, so a flag cannot imply a pass that never ran. Both browser lanes now name
 * the READ that forced the flush (flush-site): Chrome from Blink's `.stack` at the flush, Firefox
 * from the sampled DOM-accessor stacks (the read line, not the marker's write cause). A plan with
 * neither produces no blame and gets no semantic (--target node, or Chrome with --no-trace).
 */
export function blameSemanticFor(specs: PassSpec[]): BlameSemantic | undefined {
  // The gecko pass surfaces read-site blame from the sampled stacks (the write-cause markers stay
  // reachable via `query get`, but are not the blame answer), so this lane is flush-site too.
  if (specs.some((spec) => spec.gecko)) return "flush-site";
  // Flush-site blame is Blink's stack at the forced flush, which needs the `.stack` category. The
  // --breakdown pass has categories but drops `.stack`, so it produces no blame; excluding it by
  // name keeps this from claiming a semantic for lines that were never captured.
  if (specs.some((spec) => spec.categories && spec.name !== "breakdown")) return "flush-site";
  return undefined;
}
