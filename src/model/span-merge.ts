// Merge repeated `measure` spans into ONE honest bar, mirroring the step philosophy (trace/steps.ts
// mergeSteps): a `performance.measure` label that recurs -- once per --iteration, and/or more than
// once within an iteration -- has those occurrences as its samples, so the reported bar is the
// sample with the MEDIAN wall, not iteration 1's.

import type { SpanBreakdown } from "./recording.js";

/**
 * Lower-median index of a sorted-ascending array of `count` elements: `floor((count - 1) / 2)`, so an
 * even count picks the LOWER of the two middles. The result is therefore a real element index, never
 * an average between two -- which is the whole point: a bar must stay a real reconciling sample.
 */
function lowerMedianIndex(count: number): number {
  return Math.floor((count - 1) / 2);
}

/**
 * Collapse repeated `measure` spans, keyed by label, to a single bar per label. The kept bar is the
 * occurrence whose `breakdown.wallMs` is the lower median across all occurrences -- a real sample, so
 * `Σ slices + idle = wall` holds byte-for-byte (averaging slices independently would fabricate a bar
 * that no occurrence ever produced). The merged entry discloses the merge: `samples` (occurrence
 * count) and the wall spread (`wallMinMs`/`wallMaxMs`).
 *
 * run/step spans and single-occurrence measures pass through UNCHANGED, with no disclosure fields, so
 * an unrepeated flow and old recordings stay byte-identical. Input order is preserved by first
 * occurrence of each label; the run span (emitted first by both lanes) stays first.
 */
export function mergeSpanOccurrences(spans: SpanBreakdown[]): SpanBreakdown[] {
  const groups = new Map<string, SpanBreakdown[]>();
  const order: string[] = [];
  for (const span of spans) {
    // Key on kind too, so a (hypothetical) label shared by a step and a measure never merges across
    // kinds. run/step labels are unique within a recording, so their groups stay length 1.
    const key = `${span.kind}:${span.label}`;
    const group = groups.get(key);
    if (group) group.push(span);
    else {
      groups.set(key, [span]);
      order.push(key);
    }
  }

  const merged: SpanBreakdown[] = [];
  for (const key of order) {
    const group = groups.get(key)!;
    // Only measures merge. A single occurrence, or a run/step (unique label), passes through as the
    // exact object it was -- no samples/spread fields, so nothing about existing bars changes.
    if (group.length === 1 || group[0].kind !== "measure") {
      merged.push(group[0]);
      continue;
    }
    const byWall = [...group].sort((left, right) => left.breakdown.wallMs - right.breakdown.wallMs);
    const picked = byWall[lowerMedianIndex(byWall.length)];
    merged.push({
      ...picked,
      samples: group.length,
      wallMinMs: byWall[0].breakdown.wallMs,
      wallMaxMs: byWall[byWall.length - 1].breakdown.wallMs,
    });
  }
  return merged;
}
