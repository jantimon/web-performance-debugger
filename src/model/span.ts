// The Span primitive: one labelled unit of measured work -- the run window, a driver step, or a user
// `performance.measure` -- carrying its per-occurrence samples. Everything the recording models as a
// separate thing (the `wpd:run` window, a `measureStep`, an `--iterations` repetition, a user
// `performance.measure`) is one Span with per-label samples; the aggregation says how those samples
// combine. `spanAggregation` (model/spans.ts) is the single classifier both this model and the
// stored bars share.

import type { Breakdown, SpanAggregation, SpanBreakdown, SpanKind } from "./recording.js";
import type { Measured } from "./measured.js";
import { spanAggregation } from "./spans.js";

/**
 * The exact rendering counts windowed to ONE span occurrence. A forced flush is already inside the
 * `layoutCount`/`styleCount` (`forcedLayoutCount` re-reports the JS-triggered SUBSET of that same
 * work), so a reader must never sum `forcedLayoutCount` onto layout + style. Each field is
 * `Measured`: a mode that cannot observe a count reports null, never a fake 0 (e.g. `--breakdown`
 * drops the `.stack` category forced detection needs, so `forcedLayoutCount` is null there).
 */
export interface SpanCounts {
  layoutCount: Measured<number>;
  styleCount: Measured<number>;
  paintCount: Measured<number>;
  /** the JS-forced SUBSET of `layoutCount`/`styleCount`, never a separate addend */
  forcedLayoutCount: Measured<number>;
}

/**
 * One occurrence of a span: a single measured window, its reconciling seven-slice decomposition, and
 * the counts windowed to it. `wallMs` is the window span on the trace clock (`Breakdown.wallMs`), so
 * `Σ slices + idle === wallMs`. A Span with `--iterations` carries one sample per iteration; a
 * repeated `performance.measure` carries one per occurrence.
 */
export interface SpanSample {
  wallMs: number;
  breakdown: Breakdown;
  counts: SpanCounts;
}

/**
 * A labelled unit of measured work and its samples. `aggregation` states how the samples combine
 * into a headline (see SpanAggregation); it is derivable from `kind` + `samples.length` via
 * `spanAggregation`, and stored so a consumer reads it without re-deriving. The raw samples are kept,
 * not just an aggregate: a median hides the bimodality ("the first iteration was cold") that is
 * usually the finding.
 */
export interface Span {
  label: string;
  kind: SpanKind;
  aggregation: SpanAggregation;
  samples: SpanSample[];
}

/**
 * Counts a source carries no per-occurrence rendering counts for. The stored seven-slice bars
 * (`SpanBreakdown`) are a `--breakdown`-mode product, which drops the `.stack` category and windows
 * no per-span counters, so every count is not-measured there. A fake 0 would read as "measured
 * clean"; null says "this mode did not observe it" (model/measured.ts).
 */
export function notMeasuredSpanCounts(): SpanCounts {
  return { layoutCount: null, styleCount: null, paintCount: null, forcedLayoutCount: null };
}

/**
 * Group per-occurrence seven-slice bars into Spans, one per (kind, label), preserving first-occurrence
 * order. Each occurrence becomes a `SpanSample` carrying that occurrence's `breakdown` verbatim; a
 * `measure` label repeated across `--iterations` (or within one) yields a multi-sample Span. Keyed on
 * kind as well as label, so a label shared by a step and a measure never groups across kinds (run/step
 * labels are unique, so their Spans stay single-sample). Counts are not-measured: `SpanBreakdown`
 * carries no per-span counters (see notMeasuredSpanCounts).
 *
 * This is the un-collapsed view of the same occurrences `mergeSpanOccurrences` (model/span-merge.ts)
 * reduces to one stored bar per (kind, label): it keeps every sample rather than picking the
 * lower-median one.
 */
export function spansFromOccurrences(occurrences: SpanBreakdown[]): Span[] {
  const byKeyedLabel = new Map<string, { label: string; kind: SpanKind; samples: SpanSample[] }>();
  const order: string[] = [];
  for (const occurrence of occurrences) {
    // Same grouping key as mergeSpanOccurrences (model/span-merge.ts); the two must not diverge.
    const key = `${occurrence.kind}:${occurrence.label}`;
    const sample: SpanSample = {
      wallMs: occurrence.breakdown.wallMs,
      breakdown: occurrence.breakdown,
      counts: notMeasuredSpanCounts(),
    };
    const existing = byKeyedLabel.get(key);
    if (existing) existing.samples.push(sample);
    else {
      byKeyedLabel.set(key, { label: occurrence.label, kind: occurrence.kind, samples: [sample] });
      order.push(key);
    }
  }
  return order.map((key) => {
    const group = byKeyedLabel.get(key)!;
    return { ...group, aggregation: spanAggregation(group.kind, group.samples.length) };
  });
}
