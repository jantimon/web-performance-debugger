// Helpers for the stored `Span` (model/recording.ts): the not-measured counts value and the
// projection of a run/step `RecordingSummary` onto a span's `counts`. The Span shape itself and the
// `${kind}:${label}` grouping key live with the model (recording.ts) and its merger
// (model/span-merge.ts); this file only builds the count sub-object.

import type { Recording, Span, SpanCounts } from "./recording.js";
import type { RecordingSummary } from "../metrics/summarize.js";

/**
 * Counts a span carries no per-occurrence rendering counts for. Every field is null (not-measured),
 * never a fake 0: a 0 would read as "measured clean", and the default/--breakdown/measure capture modes
 * did not window these counts. See model/measured.ts for the tri-state contract.
 */
export function notMeasuredSpanCounts(): SpanCounts {
  return {
    layoutCount: null,
    styleCount: null,
    paintCount: null,
    forcedLayoutCount: null,
    layoutInvalidations: null,
    paintInvalidations: null,
    styleInvalidations: null,
    longTaskCount: null,
  };
}

/**
 * The Measured rendering counts a build-time `RecordingSummary` carries, as a span's `counts`. The run
 * span reads the run summary; a step span reads the summary of its own windowed events. Not-measured
 * fields stay null (see notMeasuredSpanCounts).
 */
export function countsFromSummary(summary: RecordingSummary): SpanCounts {
  return {
    layoutCount: summary.layoutCount,
    styleCount: summary.styleCount,
    paintCount: summary.paintCount,
    forcedLayoutCount: summary.forcedLayoutCount,
    layoutInvalidations: summary.layoutInvalidations,
    paintInvalidations: summary.paintInvalidations,
    styleInvalidations: summary.styleInvalidations,
    longTaskCount: summary.longTaskCount,
  };
}

/**
 * The run span (`kind: "run"`) -- the schema-5 home of the run-level counts, wall, INP, longest-task
 * duration and per-iteration stats that a pre-5 recording kept in `summary`. Every recording carries
 * one; absent only on a hand-built or empty artifact.
 */
export function runSpan(recording: Recording): Span | undefined {
  return recording.spans?.find((span) => span.kind === "run");
}
