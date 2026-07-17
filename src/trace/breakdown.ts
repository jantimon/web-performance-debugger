import type { Breakdown, EventKind, NormalizedEvent } from "../model/recording.js";

/**
 * One CPU sample projected onto the trace clock, for subdividing the js slice by package.
 *
 * `ts` is the sample's absolute trace-clock timestamp (microseconds) -- the same clock the trace
 * events carry, so a sample can be tested for membership in a scripting self-time region. `package`
 * is the resolved owning package of the sample's leaf frame, or null for a frame with no owner
 * (idle/gc/system/tool). Sampled time is NEVER added to the trace-measured ms; samples only supply
 * proportions.
 */
export interface BreakdownSample {
  ts: number;
  package: string | null;
}

/** The six non-idle work slices an event kind can land in; `idle` is the window remainder, not a kind. */
type WorkSlice = "js" | "style" | "layout" | "paint" | "gc" | "other";

/** Which of the seven work slices an event kind lands in. */
function sliceOf(kind: EventKind): WorkSlice {
  switch (kind) {
    case "scripting":
      return "js";
    case "style":
      return "style";
    case "layout":
      return "layout";
    case "paint":
      return "paint";
    case "gc":
      return "gc";
    default:
      // task remainder + composite/invalidation/user-timing/other: the floor bucket, kept visible.
      return "other";
  }
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

const US_PER_MS = 1000;
/** Float dust below this (ms) is not a real residual; the tiling is exact by construction. */
const RESIDUAL_EPSILON_MS = 1e-6;

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
  const jsMs = sliceUs.js / US_PER_MS;
  const byPackage = splitJsByPackage(jsMs, jsSegments, samples);

  const idleMs = sliceUs.idle / US_PER_MS;
  const breakdown: Breakdown = {
    wallMs: windowUs / US_PER_MS,
    slices: {
      js: { ms: jsMs, byPackage },
      style: { ms: sliceUs.style / US_PER_MS },
      layout: { ms: sliceUs.layout / US_PER_MS },
      paint: { ms: sliceUs.paint / US_PER_MS },
      gc: { ms: sliceUs.gc / US_PER_MS },
      other: { ms: sliceUs.other / US_PER_MS },
      idle: { ms: idleMs },
    },
  };

  // The tiling is exact by construction (segments cover [startTs, endTs] with no gap or overlap),
  // so this residual is a safety valve for float dust or a future lost-event bug, never a rescale.
  const summed =
    breakdown.slices.js.ms +
    breakdown.slices.style.ms +
    breakdown.slices.layout.ms +
    breakdown.slices.paint.ms +
    breakdown.slices.gc.ms +
    breakdown.slices.other.ms +
    breakdown.slices.idle.ms;
  const residual = breakdown.wallMs - summed;
  if (Math.abs(residual) > RESIDUAL_EPSILON_MS) breakdown.residualMs = residual;

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
    if (!inAnySegment(sample.ts, sorted)) continue;
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
