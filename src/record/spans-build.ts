// Assemble a recording's stored `Span[]` (model/recording.ts): the run window, each driver step, and
// every user `performance.measure`. This is where the three former artifacts (recording / digest /
// step index) collapse into one shape -- a step is a span of `kind: "step"`, carrying the same
// windowed counts the old per-step recording did (buildSummary over its window), and the reconciling
// bar from `bars` when the rung built one.

import { buildSummary, type CaptureCapabilities } from "../metrics/summarize.js";
import { countsFromSummary, notMeasuredSpanCounts } from "../model/span.js";
import { spanAggregation } from "../model/spans.js";
import type { MergedStep } from "../trace/steps.js";
import type { NormalizedEvent, RecordingSummary, Span, SpanBreakdown } from "../model/recording.js";

export interface SpansBuildInput {
  /** the run-level summary: the run span's wall, counts, INP, and per-iteration stats */
  summary: RecordingSummary;
  /** driver steps (label/wall/INP/interaction/window); absent on bench/node */
  mergedSteps?: MergedStep[];
  /** the trace event log, for windowing each step's counts (empty on rungs with no trace) */
  detailEvents: NormalizedEvent[];
  /** what the rung could observe, so per-step counts gate to Measured null vs a number */
  capabilities: CaptureCapabilities;
  /** the reconciling per-span bars (run/step/measure) the rung built, or [] when it built none */
  bars: SpanBreakdown[];
}

/**
 * Build the recording's `Span[]`: one run span, one per driver step, one per user measure. The run
 * and step spans carry exact windowed counts; a bar (breakdown + frames) is attached when the rung
 * built one for that span, joined by the `${kind}:${label}` key. Measure spans come straight from the
 * (already median-merged) measure bars. Always returns at least the run span.
 */
export function buildRecordingSpans(input: SpansBuildInput): Span[] {
  const { summary, mergedSteps, detailEvents, capabilities, bars } = input;
  const barByKey = new Map(bars.map((bar) => [`${bar.kind}:${bar.label}`, bar]));
  const spans: Span[] = [];

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
    const windowEvents = detailEvents.filter(
      (event) =>
        step.startTs != null &&
        event.ts >= step.startTs &&
        (step.endTs == null || event.ts <= step.endTs),
    );
    const stepSummary = buildSummary({
      wallMs: step.wallMs,
      inpMs: step.inpMs,
      interaction: step.interaction,
      detailEvents: windowEvents,
      detailWindowStart: step.startTs,
      perIteration: step.perIteration,
      capabilities,
    });
    const stepBar = barByKey.get(`step:${step.label}`);
    spans.push({
      label: step.label,
      kind: "step",
      aggregation: spanAggregation("step"),
      index: step.index,
      wallMs: step.wallMs,
      ...(stepBar?.breakdown ? { breakdown: stepBar.breakdown } : {}),
      counts: countsFromSummary(stepSummary),
      inpMs: step.inpMs,
      interaction: step.interaction,
      perIteration: step.perIteration,
      stats: stepSummary.stats,
      ...(stepBar?.frames ? { frames: stepBar.frames } : {}),
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
    });
  }

  return spans;
}
