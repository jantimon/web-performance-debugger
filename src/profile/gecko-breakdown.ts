/**
 * The Firefox reconciling breakdown, built from a converted Gecko profile's per-sample slice
 * classification (`raw.gecko.sampleSlices`, attached by geckoToRawCpuProfile when the `threadCPUDelta`
 * CPU signal is present). Firefox has no DevTools trace, so unlike the Chrome seven-slice engine
 * (trace/breakdown.ts) these slices come from the CPU samples alone: every sample's wall-delta is
 * attributed to exactly one slice, so `Σ slices === Σ timeDeltas` (the profile's own window) EXACTLY,
 * the same tiling promise as the four-slice chrome bar. The `js` slice is subdivided by owning
 * package from the sample's node, reusing the run's resolver via `packagesByProfileNode`.
 */

import type { RawCpuProfile } from "./cpuprofile.js";
import type { Breakdown, CpuBreakdown, SpanBreakdown } from "../model/recording.js";
import { usToMs } from "../model/time.js";
import { reconcileResidual } from "../model/reconcile.js";

/** Per-slice microsecond sums for one window, plus the js by-package subdivision. */
interface SliceSums {
  js: number;
  style: number;
  layout: number;
  gc: number;
  browser: number;
  idle: number;
  byPackageUs: Map<string, number>;
}

/**
 * Sum sample wall-deltas by slice over the samples whose indices are in `[fromIndex, toIndex)`.
 * `packageByNode` maps a cpuprofile node id to its owning package (null for a node with no owner);
 * only js samples with a known owner contribute to the by-package split.
 */
function sumSlices(
  raw: RawCpuProfile,
  packageByNode: Map<number, string | null>,
  fromIndex: number,
  toIndex: number,
): SliceSums {
  const sums: SliceSums = {
    js: 0,
    style: 0,
    layout: 0,
    gc: 0,
    browser: 0,
    idle: 0,
    byPackageUs: new Map(),
  };
  const sampleSlices = raw.gecko!.sampleSlices;
  for (let index = fromIndex; index < toIndex; index++) {
    const deltaUs = raw.timeDeltas[index] ?? 0;
    switch (sampleSlices[index]) {
      case "js": {
        sums.js += deltaUs;
        // js.ms carries every js delta so the slice sum stays exact; byPackage is the subset whose
        // owner is known (a native js leaf resolves to "(native)", so a null owner is rare).
        const owner = packageByNode.get(raw.samples[index]) ?? null;
        if (owner != null)
          sums.byPackageUs.set(owner, (sums.byPackageUs.get(owner) ?? 0) + deltaUs);
        break;
      }
      case "style":
        sums.style += deltaUs;
        break;
      case "layout":
        sums.layout += deltaUs;
        break;
      case "gc":
        sums.gc += deltaUs;
        break;
      case "idle":
        sums.idle += deltaUs;
        break;
      case "other":
        sums.browser += deltaUs;
        break;
    }
  }
  return sums;
}

/** Descending "package -> ms" map from the by-package microsecond sums. */
function byPackageMs(byPackageUs: Map<string, number>): Record<string, number> {
  const byPackage: Record<string, number> = {};
  for (const [owner, microseconds] of [...byPackageUs].sort((left, right) => right[1] - left[1]))
    byPackage[owner] = usToMs(microseconds);
  return byPackage;
}

/**
 * The run-level `js · style · layout · browser · gc · idle` bar (`CpuModel.breakdown` on Firefox).
 * `wallMs` is the profile's own summed deltas (= `CpuModel.totalMs`), so the bar reconciles by
 * construction. It sums every sample `[0, length)`, the same bounds `buildGeckoSpanBreakdowns` gives
 * the run span, so the run-bar wall matches across `query cpu` and `query digest`. Requires
 * `raw.gecko` (present only when the CPU signal populated the idle slice).
 */
export function computeGeckoCpuBreakdown(
  raw: RawCpuProfile,
  packageByNode: Map<number, string | null>,
  totalMs: number,
): CpuBreakdown {
  const sums = sumSlices(raw, packageByNode, 0, raw.samples.length);
  const breakdown: CpuBreakdown = {
    wallMs: totalMs,
    slices: {
      js: { ms: usToMs(sums.js), byPackage: byPackageMs(sums.byPackageUs) },
      style: { ms: usToMs(sums.style) },
      layout: { ms: usToMs(sums.layout) },
      browser: { ms: usToMs(sums.browser) },
      gc: { ms: usToMs(sums.gc) },
      idle: { ms: usToMs(sums.idle) },
    },
  };
  const sliceSum =
    breakdown.slices.js.ms +
    breakdown.slices.style!.ms +
    breakdown.slices.layout!.ms +
    breakdown.slices.browser.ms +
    breakdown.slices.gc.ms +
    breakdown.slices.idle.ms;
  const residual = reconcileResidual(breakdown.wallMs, sliceSum);
  if (residual !== undefined) breakdown.residualMs = residual;
  return breakdown;
}

/** A user `performance.measure` window on the Gecko profiler clock (microseconds). */
export interface GeckoMeasureWindow {
  label: string;
  startTs: number;
  endTs: number;
}

/** Sample index bounds `[from, to)` whose absolute profiler ts falls inside `[startTs, endTs]`.
 * The Gecko converter sets `startTime` to the FIRST windowed sample's own time, so `timeDeltas[0]`
 * (the gap from the last pre-window sample) is the one delta not to add: sample 0 is at `startTime`,
 * sample i at `startTime + Σ_{1..i} timeDeltas`. */
function windowBounds(
  raw: RawCpuProfile,
  startTs: number,
  endTs: number,
): { from: number; to: number } {
  let from = raw.samples.length;
  let to = 0;
  let clock = raw.startTime;
  for (let index = 0; index < raw.samples.length; index++) {
    if (index > 0) clock += raw.timeDeltas[index] ?? 0;
    if (clock >= startTs && clock <= endTs) {
      if (index < from) from = index;
      to = index + 1;
    }
  }
  return from <= to ? { from, to } : { from: 0, to: 0 };
}

/** One seven-slice `Breakdown` (paint is always 0 on Firefox: main-thread paint is off on the
 * compositor, a side track, never summed into the wall) for the samples in `[from, to)`. */
function spanBreakdown(
  raw: RawCpuProfile,
  packageByNode: Map<number, string | null>,
  from: number,
  to: number,
): Breakdown {
  const sums = sumSlices(raw, packageByNode, from, to);
  const wallUs = sums.js + sums.style + sums.layout + sums.gc + sums.browser + sums.idle;
  const breakdown: Breakdown = {
    wallMs: usToMs(wallUs),
    slices: {
      js: { ms: usToMs(sums.js), byPackage: byPackageMs(sums.byPackageUs) },
      style: { ms: usToMs(sums.style) },
      layout: { ms: usToMs(sums.layout) },
      paint: { ms: 0 },
      gc: { ms: usToMs(sums.gc) },
      // DOM-accessor time + Profiler self-overhead + everything non-work-classified.
      other: { ms: usToMs(sums.browser) },
      idle: { ms: usToMs(sums.idle) },
    },
  };
  // Every in-window delta lands in one slice, so this closes; the valve only catches float dust.
  const residual = reconcileResidual(
    breakdown.wallMs,
    breakdown.slices.js.ms +
      breakdown.slices.style.ms +
      breakdown.slices.layout.ms +
      breakdown.slices.paint.ms +
      breakdown.slices.gc.ms +
      breakdown.slices.other.ms +
      breakdown.slices.idle.ms,
  );
  if (residual !== undefined) breakdown.residualMs = residual;
  return breakdown;
}

/**
 * One `SpanBreakdown` per user `performance.measure` inside the run window (the §14 mark bridge on
 * Firefox). The run span is emitted first so the report keeps a whole-window bar alongside the
 * measures. Returns [] when there are no user measures, so a plain run leaves `Recording.breakdowns`
 * unset and the run bar is shown via `CpuModel.breakdown` instead.
 *
 * The run span covers every sample `[0, length)`: the profile is already restricted to the run
 * window at conversion, so this IS the run window, and its slice sum equals `CpuModel.totalMs` by
 * construction, the same wall `CpuModel.breakdown` reports. So the run-bar wall reconciles across
 * `query digest` and `query cpu`. Re-deriving the bounds with `windowBounds` would rebuild the
 * sample clock delta-by-delta and could trim the boundary sample, opening a one-sample-gap wall
 * difference between the two views; measure spans, which ARE sub-windows, still use `windowBounds`.
 */
export function buildGeckoSpanBreakdowns(
  raw: RawCpuProfile,
  packageByNode: Map<number, string | null>,
  measures: GeckoMeasureWindow[],
  runWindow: { startTs: number | null; endTs: number | null },
): SpanBreakdown[] {
  if (!raw.gecko || measures.length === 0) return [];
  const spans: SpanBreakdown[] = [];
  if (runWindow.startTs != null && runWindow.endTs != null) {
    spans.push({
      label: "run",
      kind: "run",
      breakdown: spanBreakdown(raw, packageByNode, 0, raw.samples.length),
    });
  }
  for (const measure of measures) {
    const bounds = windowBounds(raw, measure.startTs, measure.endTs);
    spans.push({
      label: measure.label,
      kind: "measure",
      breakdown: spanBreakdown(raw, packageByNode, bounds.from, bounds.to),
    });
  }
  return spans;
}
