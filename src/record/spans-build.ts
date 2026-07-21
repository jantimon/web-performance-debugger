// Assemble a recording's stored `Span[]` (model/recording.ts): the run window, each driver step, and
// every user `performance.measure`. This is where the three former artifacts (recording / digest /
// step index) collapse into one shape -- a step is a span of `kind: "step"`, carrying the same
// windowed counts the old per-step recording did (buildSummary over its window), and the reconciling
// bar from `bars` when the capture mode built one.

import {
  buildSummary,
  NO_RENDERING_CAPTURE,
  type CaptureCapabilities,
} from "../metrics/summarize.js";
import { mainThread, REANCHOR_MAX_MARKER_SHARE } from "../trace/main-thread.js";
import { countsFromSummary, notMeasuredSpanCounts } from "../model/span.js";
import { spanAggregation } from "../model/spans.js";
import type { MergedStep } from "../trace/steps.js";
import type { NormalizedEvent, RecordingSummary, Span, SpanBreakdown } from "../model/recording.js";

export interface SpansBuildInput {
  /** the run-level summary: the run span's wall, counts, INP, and per-iteration stats */
  summary: RecordingSummary;
  /** driver steps (label/wall/INP/interaction/window); absent on bench/node */
  mergedSteps?: MergedStep[];
  /** the trace event log, for windowing each step's counts (empty in capture modes with no trace) */
  detailEvents: NormalizedEvent[];
  /** what the capture mode could observe, so per-step counts gate to Measured null vs a number */
  capabilities: CaptureCapabilities;
  /** the reconciling per-span bars (run/step/measure) the capture mode built, or [] when it built none */
  bars: SpanBreakdown[];
  /** the run window's end (trace clock), so a step whose end mark was lost windows its counts to the
   * run end exactly like its bar. null in capture modes with no trace / an unclosed run window. */
  runWindowEnd: number | null;
}

/**
 * Whether a step's window ran on a renderer process OTHER than the selected main thread: the selected
 * thread carried a VANISHING share of the step's layout/paint (a stray flush or none) while another
 * thread carried the rest. On a cross-process-split run this means the step's work landed on an
 * un-selected process (a second navigation), so its counts scoped to the selected thread would read a
 * fake measured-clean ~0. A genuinely idle step (no rendering anywhere) is NOT uncovered -- its 0 is
 * real. Same vanishing-share test as the main-thread re-anchor, so one threshold governs both.
 *
 * Applied ONLY within a run the selector already flagged `split` (the caller gates on it): that flag
 * carries the disjoint-in-time discriminator that separates a successive navigation from a CONCURRENT
 * same-page OOPIF. Without the split gate this test would fire for an OOPIF-heavy step whose top thread
 * did little -- but an OOPIF's own-process count is a separate off-thread count by design, so the top
 * thread's small count IS the honest top-process-scoped answer there, not a fake 0 to null.
 */
function stepRanOnUnselectedProcess(
  windowEvents: NormalizedEvent[],
  thread: { pid: number; tid: number },
): boolean {
  let onSelected = 0;
  let onOthers = 0;
  for (const event of windowEvents) {
    if (event.kind !== "layout" && event.kind !== "paint") continue;
    if (event.sampled || event.pid == null || event.tid == null) continue;
    if (event.pid === thread.pid && event.tid === thread.tid) onSelected++;
    else onOthers++;
  }
  return onOthers > 0 && onSelected < onOthers * REANCHOR_MAX_MARKER_SHARE;
}

/**
 * Build the recording's `Span[]`: one run span, one per driver step, one per user measure. The run
 * and step spans carry exact windowed counts; a bar (breakdown + frames) is attached when the capture
 * mode built one for that span, joined by the `${kind}:${label}` key. Measure spans come straight from the
 * (already median-merged) measure bars. Always returns at least the run span.
 */
export function buildRecordingSpans(input: SpansBuildInput): Span[] {
  const { summary, mergedSteps, detailEvents, capabilities, bars, runWindowEnd } = input;
  const barByKey = new Map(bars.map((bar) => [`${bar.kind}:${bar.label}`, bar]));
  const spans: Span[] = [];

  // The run's main-thread selection, from the full event log (which carries the run:start marker).
  // Each step's counts are scoped to THIS thread instead of re-selecting from the step's own
  // marker-less window (where the heuristic could land on the OOPIF thread), so a step's counts sit on
  // the same thread as its bar -- buildBreakdowns scopes the step bar to this same selection.
  const runThread = mainThread(detailEvents);

  // Run span: the whole-run window. Its counts, wall, INP and per-iteration stats are the run summary.
  const runBar = barByKey.get("run:run");
  spans.push({
    label: "run",
    kind: "run",
    aggregation: spanAggregation("run"),
    wallMs: summary.wallMs,
    ...(runBar?.breakdown ? { breakdown: runBar.breakdown } : {}),
    counts: countsFromSummary(summary),
    ...(summary.inpMs != null ? { inpMs: summary.inpMs } : {}),
    ...(summary.interaction ? { interaction: summary.interaction } : {}),
    ...(summary.perIteration.length ? { perIteration: summary.perIteration } : {}),
    ...(summary.stats ? { stats: summary.stats } : {}),
    ...(runBar?.frames ? { frames: runBar.frames } : {}),
  });

  // Step spans: each step's counts come from buildSummary over its own trace window (the same
  // windowing the old per-step recording used, so the numbers are identical), gated to iteration 0.
  for (const step of mergedSteps ?? []) {
    // A step whose end mark was lost (endTs null) windows to the run end, matching its bar
    // (breakdown-spans.ts uses the same `step.endTs ?? runWindow.endTs`), so counts and bar cover the
    // same events rather than the counts running open to trace end.
    const stepEnd = step.endTs ?? runWindowEnd;
    const windowEvents = detailEvents.filter(
      (event) =>
        step.startTs != null &&
        event.ts >= step.startTs &&
        (stepEnd == null || event.ts <= stepEnd),
    );
    // On a cross-process-split run (runThread.split, which carries the disjoint-in-time discriminator
    // separating a second navigation from a concurrent OOPIF), a step whose work ran on an un-selected
    // renderer process is NOT-COVERED by the selected thread: report its counts as not-measured (null),
    // never the fake measured-clean 0 the selected-thread window would produce. The run-level split note
    // discloses it; here the honesty is per step, in the artifact, so no consumer reads that 0 as real
    // work. A non-split run never nulls a step: a concurrent OOPIF's small top-thread count is honest.
    const stepCapabilities =
      runThread?.split && stepRanOnUnselectedProcess(windowEvents, runThread)
        ? NO_RENDERING_CAPTURE
        : capabilities;
    const stepSummary = buildSummary({
      wallMs: step.wallMs,
      inpMs: step.inpMs,
      interaction: step.interaction,
      detailEvents: windowEvents,
      detailWindowStart: step.startTs,
      perIteration: step.perIteration,
      capabilities: stepCapabilities,
      thread: runThread,
    });
    const stepBar = barByKey.get(`step:${step.label}`);
    spans.push({
      label: step.label,
      kind: "step",
      aggregation: spanAggregation("step"),
      index: step.index,
      wallMs: step.wallMs,
      ...(step.wallClock ? { wallClock: step.wallClock } : {}),
      ...(stepBar?.breakdown ? { breakdown: stepBar.breakdown } : {}),
      counts: countsFromSummary(stepSummary),
      inpMs: step.inpMs,
      interaction: step.interaction,
      ...(step.loaf ? { loaf: step.loaf } : {}),
      perIteration: step.perIteration,
      stats: stepSummary.stats,
      ...(stepBar?.frames ? { frames: stepBar.frames } : {}),
      ...(stepBar?.hot ? { hot: stepBar.hot } : {}),
    });
  }

  // Measure spans: the user performance.measure bars, already collapsed per label to their
  // lower-median-by-wall sample (model/span-merge.ts). Windowed counts do not apply to a measure.
  for (const bar of bars) {
    if (bar.kind !== "measure") continue;
    spans.push({
      label: bar.label,
      kind: "measure",
      aggregation: spanAggregation("measure", bar.samples),
      wallMs: bar.breakdown.wallMs,
      breakdown: bar.breakdown,
      counts: notMeasuredSpanCounts(),
      ...(bar.samples != null ? { samples: bar.samples } : {}),
      ...(bar.wallMinMs != null ? { wallMinMs: bar.wallMinMs } : {}),
      ...(bar.wallMaxMs != null ? { wallMaxMs: bar.wallMaxMs } : {}),
      ...(bar.frames ? { frames: bar.frames } : {}),
      ...(bar.hot ? { hot: bar.hot } : {}),
    });
  }

  return spans;
}
