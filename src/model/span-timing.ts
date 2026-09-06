import type { Span } from "./recording.js";
import type { SpanTiming } from "./query.js";
import { computeStats } from "../metrics/summarize.js";

/** Read measured samples without substituting a trace window or an aggregate wall */
export function spanTiming(span: Span): SpanTiming | null {
  if (span.kind !== "run" && span.kind !== "step") return null;
  const samples = span.perIteration;
  if (
    !Array.isArray(samples) ||
    !samples.length ||
    samples.some((value) => !Number.isFinite(value) || value < 0)
  )
    return null;
  return {
    sampleUnit: "iteration",
    boundary: span.kind === "run" ? "run-call" : "driver-step",
    clock: span.wallClock ?? null,
    samplesMs: [...samples],
    stats: computeStats(samples),
  };
}
