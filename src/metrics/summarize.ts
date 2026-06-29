import type { BenchStats, NormalizedEvent, RecordingSummary } from "../model/recording.js";
import { invalidationKind } from "../trace/classify.js";
import { LONG_TASK_MS, inWindow } from "../trace/analysis.js";
// inWindow is start-onward by design; see the note in analysis.ts.

function median(sorted: number[]): number {
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Coarse on purpose: Chrome clamps performance.now, so only min/median/mean/max. */
export function computeStats(perIteration: number[]): BenchStats | null {
  if (perIteration.length < 2) return null;
  const sorted = [...perIteration].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    minMs: sorted[0],
    medianMs: median(sorted),
    meanMs: sorted.reduce((left, right) => left + right, 0) / sorted.length,
    maxMs: sorted[sorted.length - 1],
  };
}

export interface SummaryInputs {
  detailEvents: NormalizedEvent[];
  detailWindowStart: number | null;
  /** CDP getMetrics delta from the clean (timing) pass; {} for per-step trace-only */
  cdpDelta: Record<string, number>;
  wallMs?: number | null;
  inpMs?: number | null;
  /** bench (in-page iterations) per-iteration wall times */
  perIteration?: number[];
}

export function buildSummary(input: SummaryInputs): RecordingSummary {
  const { detailEvents, detailWindowStart, cdpDelta } = input;
  const perIteration = input.perIteration ?? [];

  let paintCount = 0;
  let paintUs = 0;
  let compositeCount = 0;
  let compositeUs = 0;
  let traceLayoutCount = 0;
  let traceLayoutUs = 0;
  let traceStyleCount = 0;
  let traceStyleUs = 0;
  let forcedLayoutCount = 0;
  let forcedLayoutUs = 0;
  let longTaskCount = 0;
  let longestTaskUs = 0;
  let layoutInval = 0;
  let paintInval = 0;
  let styleInval = 0;
  let total = 0;

  for (const event of detailEvents) {
    if (!inWindow(event, detailWindowStart)) continue;
    total++;
    if (event.forced) {
      forcedLayoutCount++;
      forcedLayoutUs += event.dur;
    }
    switch (event.kind) {
      case "paint":
        paintCount++;
        paintUs += event.dur;
        break;
      case "composite":
        compositeCount++;
        compositeUs += event.dur;
        break;
      case "layout":
        traceLayoutCount++;
        traceLayoutUs += event.dur;
        break;
      case "style":
        traceStyleCount++;
        traceStyleUs += event.dur;
        break;
      case "task":
        if (event.dur >= LONG_TASK_MS * 1000) longTaskCount++;
        if (event.dur > longestTaskUs) longestTaskUs = event.dur;
        break;
      case "invalidation": {
        const invalKind = invalidationKind(event.name);
        if (invalKind === "layout") layoutInval++;
        else if (invalKind === "paint") paintInval++;
        else if (invalKind === "style") styleInval++;
        break;
      }
    }
  }

  return {
    wallMs: input.wallMs ?? null,
    inpMs: input.inpMs ?? null,
    // Prefer authoritative low-overhead CDP counters; fall back to trace counts.
    layoutCount: cdpDelta.LayoutCount ?? traceLayoutCount,
    layoutMs:
      cdpDelta.LayoutDuration != null ? cdpDelta.LayoutDuration * 1000 : traceLayoutUs / 1000,
    styleCount: cdpDelta.RecalcStyleCount ?? traceStyleCount,
    styleMs:
      cdpDelta.RecalcStyleDuration != null
        ? cdpDelta.RecalcStyleDuration * 1000
        : traceStyleUs / 1000,
    paintCount,
    paintMs: paintUs / 1000,
    compositeCount,
    compositeMs: compositeUs / 1000,
    layoutInvalidations: layoutInval,
    paintInvalidations: paintInval,
    styleInvalidations: styleInval,
    forcedLayoutCount,
    forcedLayoutMs: forcedLayoutUs / 1000,
    longTaskCount,
    longestTaskMs: longestTaskUs / 1000,
    scriptingMs: (cdpDelta.ScriptDuration ?? 0) * 1000,
    totalEvents: total,
    perIteration,
    stats: computeStats(perIteration),
  };
}
