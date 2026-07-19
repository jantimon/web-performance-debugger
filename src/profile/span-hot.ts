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
 * Merge a set of windows into a sorted, disjoint set so a sample in an overlap region counts once
 * (exactly as a membership `some()` over the raw windows counts it once). Occurrence windows of one
 * label are sequential in practice, but the input is a bare `{startTs,endTs}[]`, so overlaps are
 * representable and collapsed here rather than assumed away. Bounds are inclusive on both ends, so
 * two windows that merely touch (`next.startTs === current.endTs`) share the boundary sample and are
 * fused too.
 */
function mergeWindows(windows: readonly SpanHotWindow[]): SpanHotWindow[] {
  if (windows.length <= 1) return windows.slice();
  const sorted = [...windows].sort((left, right) => left.startTs - right.startTs);
  const merged: SpanHotWindow[] = [{ startTs: sorted[0].startTs, endTs: sorted[0].endTs }];
  for (let index = 1; index < sorted.length; index++) {
    const window = sorted[index];
    const last = merged[merged.length - 1];
    if (window.startTs <= last.endTs) last.endTs = Math.max(last.endTs, window.endTs);
    else merged.push({ startTs: window.startTs, endTs: window.endTs });
  }
  return merged;
}

/**
 * Tally the top-K hot functions for one span from the pooled samples that fall in its window(s).
 *
 * `pooledSamples` is every ranked-JS sample in any window (the share denominator); each stored
 * function's `selfMs` is `samples * interval`. The invariant is `Σ selfMs <= Σ window wall` (every
 * sample is ~one interval of time, so pooled sampled time cannot exceed the pooled window), NOT
 * `<= the bar's js.ms`. Below `MIN_POOLED_HOT_SAMPLES` the ranking is suppressed. The tie-break is
 * ascending id (the run's stable self-time rank), so equal-sample functions order deterministically.
 *
 * `samples` MUST be in ascending `ts` order (both callers project them by a cumulative sum of
 * non-negative sample deltas, so they are). Windows are merged into a sorted disjoint set and swept
 * with a single moving pointer that early-breaks once a sample passes the last window, so the cost is
 * O(samples + windows log windows) rather than O(samples x windows).
 */
export function tallySpanHot(
  samples: readonly SpanHotSample[],
  windows: readonly SpanHotWindow[],
  scope: SpanHot["scope"],
  sampleIntervalUs: number,
  topK: number = SPAN_HOT_TOP_K,
): SpanHot {
  const occurrences = windows.length;
  const disjointWindows = mergeWindows(windows);
  const samplesByFunction = new Map<number, number>();
  let pooledSamples = 0;
  let windowIndex = 0;
  for (const sample of samples) {
    if (sample.functionId == null) continue;
    // Advance past every window this sample has already cleared; ascending ts means the pointer never
    // rewinds and a sample past the last window ends the sweep.
    while (windowIndex < disjointWindows.length && sample.ts > disjointWindows[windowIndex].endTs)
      windowIndex++;
    if (windowIndex >= disjointWindows.length) break;
    if (sample.ts < disjointWindows[windowIndex].startTs) continue; // in a gap between windows
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
