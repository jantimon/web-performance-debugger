// The `query index` / `assert`-per-step VIEW, derived from a recording's step spans. After the
// collapse a stepped run is one recording whose `kind: "step"` spans carry the per-step wall, INP,
// and windowed counts; there is no stored step-index artifact. This module reads those spans into the
// StepIndexEntry shape the index printer and the step asserts consume.

import type { Recording, Span, StepIndex, StepIndexEntry } from "./recording.js";

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

/** Build the `query index` view from a recording (the derived StepIndex, no stored artifact). */
export function stepIndexView(recording: Recording, recordingPath: string): StepIndex {
  const steps = stepSpans(recording).map(stepEntry);
  return {
    meta: recording.meta,
    recording: recordingPath,
    steps,
    hints: [
      "Stepped run, derived from the recording's step spans (one artifact; no separate index file).",
      `Per-span bars: wpd query spans "${recordingPath}"`,
      `Gate a step in CI: wpd assert "${recordingPath}" --max-forced 0`,
    ],
  };
}
