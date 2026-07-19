import type { Breakdown, NormalizedEvent } from "../model/recording.js";
import { usToMs } from "../model/time.js";
import { reconcileResidual } from "../model/reconcile.js";
import { sliceOf, type WorkSlice } from "./taxonomy.js";

/**
 * One CPU sample projected onto the trace clock, for subdividing the js slice by package.
 *
 * `traceTs` is the sample's absolute timestamp on the TRACE clock (microseconds) -- named for its
 * clock because it is only comparable to trace-event timestamps, the same clock, so a sample can be
 * tested for membership in a scripting self-time region. `package` is the resolved owning package of
 * the sample's leaf frame, or null for a frame with no owner (idle/gc/system/tool). Sampled time is
 * NEVER added to the trace-measured ms; samples only supply proportions.
 */
export interface BreakdownSample {
  traceTs: number;
  package: string | null;
}

interface OpenInterval {
  end: number;
  slice: WorkSlice;
}

interface Segment {
  start: number;
  end: number;
  /** "idle" for a window gap with no main-thread work open */
  slice: WorkSlice | "idle";
}

/**
 * Decompose one span's trace window into the seven work slices + idle, tiling `[startTs, endTs]`
 * EXACTLY. Durations come from the trace: standard flame-chart disjoint self-time over the main
 * thread (children subtracted from parents), bucketed by classify.ts kind. `idle` is the window
 * remainder (never negative). The `js` slice is subdivided by package from the samples that land in
 * its self-time regions -- proportions only, so `Σ byPackage === js.ms`.
 *
 * Pure and fixture-testable: `events` must already be restricted to the renderer main thread, and
 * `samples` to the same window. Off-main-thread work (raster/compositor) must be filtered out by
 * the caller, or it would eat into idle.
 */
export function computeSpanBreakdown(
  events: NormalizedEvent[],
  samples: BreakdownSample[],
  window: { startTs: number; endTs: number },
): Breakdown {
  const { startTs, endTs } = window;
  const windowUs = Math.max(0, endTs - startTs);

  // Clamp each complete event to the window; instant (dur 0) events own no time and are dropped.
  const intervals: { start: number; end: number; slice: WorkSlice }[] = [];
  for (const event of events) {
    if (event.dur <= 0) continue;
    const start = Math.max(event.ts, startTs);
    const end = Math.min(event.ts + event.dur, endTs);
    if (end <= start) continue;
    intervals.push({ start, end, slice: sliceOf(event.kind) });
  }
  // Parent before child: earlier start first, and at an equal start the longer (container) first.
  intervals.sort((left, right) => left.start - right.start || right.end - left.end);

  const segments: Segment[] = [];
  const stack: OpenInterval[] = [];
  let cursor = startTs;

  // Attribute [cursor, target] to whatever main-thread work is innermost-open, filling idle when
  // the stack is empty; pops any interval that has finished by `target` first, so its tail lands on
  // it and not on its parent.
  const advanceTo = (target: number): void => {
    while (stack.length > 0 && stack[stack.length - 1].end <= target) {
      const top = stack[stack.length - 1];
      if (top.end > cursor) {
        segments.push({ start: cursor, end: top.end, slice: top.slice });
        cursor = top.end;
      }
      stack.pop();
    }
    if (target > cursor) {
      const slice = stack.length > 0 ? stack[stack.length - 1].slice : "idle";
      segments.push({ start: cursor, end: target, slice });
      cursor = target;
    }
  };

  for (const interval of intervals) {
    advanceTo(interval.start);
    stack.push({ end: interval.end, slice: interval.slice });
  }
  advanceTo(endTs);

  // Per-slice totals + the scripting segments (needed for sample membership).
  const sliceUs = { js: 0, style: 0, layout: 0, paint: 0, gc: 0, other: 0, idle: 0 };
  const jsSegments: { start: number; end: number }[] = [];
  for (const segment of segments) {
    const durationUs = segment.end - segment.start;
    sliceUs[segment.slice] += durationUs;
    if (segment.slice === "js") jsSegments.push({ start: segment.start, end: segment.end });
  }

  // Subdivide the js slice by package: count the samples inside a scripting region per owner, then
  // split the TRACE-measured js ms by those counts. Zero samples => empty rather than fabricated.
  const jsMs = usToMs(sliceUs.js);
  const byPackage = splitJsByPackage(jsMs, jsSegments, samples);

  const idleMs = usToMs(sliceUs.idle);
  const paintMs = usToMs(sliceUs.paint);
  const breakdown: Breakdown = {
    wallMs: usToMs(windowUs),
    slices: {
      js: { ms: jsMs, byPackage },
      style: { ms: usToMs(sliceUs.style) },
      layout: { ms: usToMs(sliceUs.layout) },
      // Chrome measures main-thread paint (null only on firefox, where it is off-main-thread).
      paint: { ms: paintMs },
      gc: { ms: usToMs(sliceUs.gc) },
      other: { ms: usToMs(sliceUs.other) },
      idle: { ms: idleMs },
    },
  };

  // The tiling is exact by construction (segments cover [startTs, endTs] with no gap or overlap),
  // so this residual is a safety valve for float dust or a future lost-event bug, never a rescale.
  const summed =
    breakdown.slices.js.ms +
    breakdown.slices.style.ms +
    breakdown.slices.layout.ms +
    paintMs +
    breakdown.slices.gc.ms +
    breakdown.slices.other.ms +
    breakdown.slices.idle.ms;
  const residual = reconcileResidual(breakdown.wallMs, summed);
  if (residual !== undefined) breakdown.residualMs = residual;

  return breakdown;
}

/** Split `jsMs` across packages by the sample counts landing inside the scripting regions. */
function splitJsByPackage(
  jsMs: number,
  jsSegments: { start: number; end: number }[],
  samples: BreakdownSample[],
): Record<string, number> {
  if (jsMs <= 0 || jsSegments.length === 0) return {};
  const sorted = [...jsSegments].sort((left, right) => left.start - right.start);
  const countByPackage = new Map<string, number>();
  let counted = 0;
  for (const sample of samples) {
    if (sample.package == null) continue;
    if (!inAnySegment(sample.traceTs, sorted)) continue;
    countByPackage.set(sample.package, (countByPackage.get(sample.package) ?? 0) + 1);
    counted++;
  }
  if (counted === 0) return {};
  const byPackage: Record<string, number> = {};
  for (const [owner, count] of [...countByPackage].sort((left, right) => right[1] - left[1]))
    byPackage[owner] = (count / counted) * jsMs;
  return byPackage;
}

/** Binary search: is `ts` inside any of the (sorted, non-overlapping) segments? */
function inAnySegment(ts: number, sorted: { start: number; end: number }[]): boolean {
  let low = 0;
  let high = sorted.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const segment = sorted[mid];
    if (ts < segment.start) high = mid - 1;
    else if (ts >= segment.end) low = mid + 1;
    else return true;
  }
  return false;
}
