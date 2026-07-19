// The per-step VIEW over a recording's step spans, shared by `assert` (per-step gating) and
// `query span <step-label>` (a step's anatomy). A stepped run is one recording whose `kind: "step"`
// spans carry the per-step wall, INP, and windowed counts; this module reads those spans into the
// StepIndexEntry shape those consumers gate/render against.

import type { Recording, Span, StepIndexEntry } from "./recording.js";

/** Every `kind: "step"` span, in index order (the position within an iteration). */
export function stepSpans(recording: Recording): Span[] {
  return recording.spans
    .filter((span) => span.kind === "step")
    .sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
}

/** Whether this recording is a stepped (driver) run: it carries at least one step span. */
export function isSteppedRecording(recording: Recording): boolean {
  return recording.spans.some((span) => span.kind === "step");
}

/** One step span as a StepIndexEntry (the index-view row / a per-step assert target). */
export function stepEntry(span: Span): StepIndexEntry {
  return {
    index: span.index ?? 0,
    label: span.label,
    wallMs: span.wallMs,
    inpMs: span.inpMs ?? null,
    interaction: span.interaction ?? null,
    stats: span.stats ?? null,
    headline: {
      layoutCount: span.counts.layoutCount,
      forcedLayoutCount: span.counts.forcedLayoutCount,
      paintCount: span.counts.paintCount,
      layoutInvalidations: span.counts.layoutInvalidations,
      styleInvalidations: span.counts.styleInvalidations,
      longTaskCount: span.counts.longTaskCount,
    },
  };
}
