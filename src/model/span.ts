// Helpers for the stored `Span` (model/recording.ts): the not-measured counts value and the
// projection of a run/step `RecordingSummary` onto a span's `counts`. The Span shape itself and the
// `${kind}:${label}` grouping key live with the model (recording.ts) and its merger
// (model/span-merge.ts); this file only builds the count sub-object.

import type { RecordingSummary, SpanCounts } from "./recording.js";

/**
 * Counts a span carries no per-occurrence rendering counts for. Every field is null (not-measured),
 * never a fake 0: a 0 would read as "measured clean", and the default/--breakdown/measure capture modes
 * simply did not window these counts. See model/measured.ts for the tri-state contract.
 */
export function notMeasuredSpanCounts(): SpanCounts {
  return {
    layoutCount: null,
    styleCount: null,
    paintCount: null,
    forcedLayoutCount: null,
    layoutInvalidations: null,
    styleInvalidations: null,
    longTaskCount: null,
  };
}

/**
 * The seven Measured rendering counts a `RecordingSummary` carries, as a span's `counts`. The run
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
    styleInvalidations: summary.styleInvalidations,
    longTaskCount: summary.longTaskCount,
  };
}
