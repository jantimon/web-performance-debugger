// Per-span hot-function tally: top-K functions by pooled ranked-JS sample count within a span's
// window(s), on the CPU-sampler scripting axis. Pure over its inputs (samples + windows + interval),
// so it is fixture-testable and shared by the chrome (--breakdown) and firefox (gecko) lanes. See
// model/recording.ts SpanHot for the axis/pooling/floor contract this enforces.

import type { SpanHot, SpanHotRef } from "../model/recording.js";
import { usToMs } from "../model/time.js";

/**
 * One CPU sample located on a clock comparable to the span windows (the trace clock on chrome, the
 * profiler clock on firefox), tagged with the ranked CpuModel function it hit. `functionId` is null
 * for a sample that is not a rankable user function (idle/gc/system/tool), so it never counts toward a
 * span's scripting samples.
 */
export interface SpanHotSample {
  ts: number;
  functionId: number | null;
}

/** One window on the same clock as the samples. A span pools over one (step) or many (measure) of these. */
export interface SpanHotWindow {
  startTs: number;
  endTs: number;
}

/** Below this many pooled ranked-JS samples a ranking is noise: suppress it, never fabricate a top-N. */
export const MIN_POOLED_HOT_SAMPLES = 10;
/** A function below this many pooled samples in the window carries no signal and is dropped from the list. */
export const MIN_FUNCTION_HOT_SAMPLES = 3;
/** How many hot functions a span stores. Bounded so the additive schema field stays digest-sized. */
export const SPAN_HOT_TOP_K = 8;

/**
 * Tally the top-K hot functions for one span from the pooled samples that fall in its window(s).
 *
 * `pooledSamples` is every ranked-JS sample in any window (the share denominator); each stored
 * function's `selfMs` is `samples * interval`. The invariant is `Σ selfMs <= Σ window wall` (every
 * sample is ~one interval of time, so pooled sampled time cannot exceed the pooled window), NOT
 * `<= the bar's js.ms`. Below `MIN_POOLED_HOT_SAMPLES` the ranking is suppressed. The tie-break is
 * ascending id (the run's stable self-time rank), so equal-sample functions order deterministically.
 */
export function tallySpanHot(
  samples: readonly SpanHotSample[],
  windows: readonly SpanHotWindow[],
  scope: SpanHot["scope"],
  sampleIntervalUs: number,
  topK: number = SPAN_HOT_TOP_K,
): SpanHot {
  const occurrences = windows.length;
  const samplesByFunction = new Map<number, number>();
  let pooledSamples = 0;
  for (const sample of samples) {
    if (sample.functionId == null) continue;
    if (!windows.some((window) => sample.ts >= window.startTs && sample.ts <= window.endTs))
      continue;
    samplesByFunction.set(sample.functionId, (samplesByFunction.get(sample.functionId) ?? 0) + 1);
    pooledSamples++;
  }
  if (pooledSamples < MIN_POOLED_HOT_SAMPLES)
    return { scope, pooledSamples, occurrences, suppressed: true };
  const functions: SpanHotRef[] = [...samplesByFunction.entries()]
    .filter(([, count]) => count >= MIN_FUNCTION_HOT_SAMPLES)
    .sort((left, right) => right[1] - left[1] || left[0] - right[0])
    .slice(0, topK)
    .map(([id, count]) => ({ id, samples: count, selfMs: usToMs(count * sampleIntervalUs) }));
  return { scope, pooledSamples, occurrences, functions };
}
