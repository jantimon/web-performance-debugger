import type { Span } from "./recording.js";
import type { SpanTiming } from "./query.js";
import { computeStats } from "../metrics/summarize.js";

/** Read measured samples without substituting a trace window or an aggregate wall */
export function spanTiming(span: Span): SpanTiming | null {
  const isMeasure = span.kind === "measure";
  const samples = isMeasure ? span.occurrenceWallMs : span.perIteration;
  if (
    !Array.isArray(samples) ||
    !samples.length ||
    samples.some((value) => !Number.isFinite(value) || value < 0)
  )
    return null;
  return {
    sampleUnit: isMeasure ? "occurrence" : "iteration",
    boundary: isMeasure ? "performance-measure" : span.kind === "run" ? "run-call" : "driver-step",
    clock: span.wallClock ?? null,
    samplesMs: [...samples],
    stats: computeStats(samples),
  };
}
