import type {
  BenchStats,
  InteractionTiming,
  NormalizedEvent,
  RecordingSummary,
  StepTiming,
} from "../model/recording.js";
import { invalidationKind } from "../trace/classify.js";
import { measuredIf } from "../model/measured.js";
import { usToMs, msToUs, cdpSecondsToMs } from "../model/time.js";
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
  /** in-page CWV split of the interaction that produced `inpMs` */
  interaction?: InteractionTiming | null;
  /** bench (in-page iterations) per-iteration wall times */
  perIteration?: number[];
  /**
   * driver (stepped) raw per-iteration wall times per step. `stats` is omitted because it is
   * derived here, not by the caller: every stats block in the model then comes from the one
   * computeStats contract, and no caller can invent a statistic that bypasses it.
   */
  perStep?: Omit<StepTiming, "stats">[];
  /**
   * Whether forced-layout detection ran (default true). False when the trace lacked the `.stack`
   * category (--breakdown): forced is then reported as null (not measured), never a fake 0, because
   * every layout in the window WOULD count as unforced with no stack to prove otherwise.
   */
  forcedMeasured?: boolean;
}

export function buildSummary(input: SummaryInputs): RecordingSummary {
  const { detailEvents, detailWindowStart, cdpDelta } = input;
  const perIteration = input.perIteration ?? [];
  const forcedMeasured = input.forcedMeasured !== false;

  let paintCount = 0;
  let paintUs = 0;
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
      case "layout":
        traceLayoutCount++;
        traceLayoutUs += event.dur;
        break;
      case "style":
        traceStyleCount++;
        traceStyleUs += event.dur;
        break;
      case "task":
        if (event.dur >= msToUs(LONG_TASK_MS)) longTaskCount++;
        if (event.dur > longestTaskUs) longestTaskUs = event.dur;
        break;
      case "invalidation": {
        const invalKind = invalidationKind(event.name);
        if (invalKind === "layout") layoutInval++;
        else if (invalKind === "paint") paintInval++;
        else if (invalKind === "style") styleInval++;
        break;
      }
      // No summary counter derives from these kinds; enumerated (not left to a silent default) so a
      // future EventKind lands on the exhaustiveness guard below and must be handled here.
      case "composite":
      case "scripting":
      case "gc":
      case "usertiming":
      case "other":
        break;
      default: {
        const exhausted: never = event.kind;
        throw new Error(`buildSummary: unhandled event kind ${String(exhausted)}`);
      }
    }
  }

  return {
    wallMs: input.wallMs ?? null,
    inpMs: input.inpMs ?? null,
    interaction: input.interaction,
    // Prefer authoritative low-overhead CDP counters; fall back to trace counts. The two branches
    // convert opposite ways: CDP durations are seconds, trace durations are microseconds.
    layoutCount: cdpDelta.LayoutCount ?? traceLayoutCount,
    layoutMs:
      cdpDelta.LayoutDuration != null
        ? cdpSecondsToMs(cdpDelta.LayoutDuration)
        : usToMs(traceLayoutUs),
    styleCount: cdpDelta.RecalcStyleCount ?? traceStyleCount,
    styleMs:
      cdpDelta.RecalcStyleDuration != null
        ? cdpSecondsToMs(cdpDelta.RecalcStyleDuration)
        : usToMs(traceStyleUs),
    // Main-thread paint chunks only; see PAINT in trace/classify.ts. There is deliberately no
    // composite count: [measured] it tracks --settle duration (7x swing on a constant workload),
    // i.e. frames elapsed, never the page's work. docs/dev/rendering-counts.md.
    paintCount,
    paintMs: usToMs(paintUs),
    layoutInvalidations: layoutInval,
    paintInvalidations: paintInval,
    styleInvalidations: styleInval,
    // null (not 0) when detection did not run: --breakdown drops the `.stack` category forced
    // detection needs, so a 0 here would read as "no thrashing" instead of "not measured".
    forcedLayoutCount: measuredIf(forcedMeasured, forcedLayoutCount),
    forcedLayoutMs: measuredIf(forcedMeasured, usToMs(forcedLayoutUs)),
    longTaskCount,
    longestTaskMs: usToMs(longestTaskUs),
    scriptingMs: cdpSecondsToMs(cdpDelta.ScriptDuration ?? 0),
    totalEvents: total,
    perIteration,
    stats: computeStats(perIteration),
    perStep: (input.perStep ?? []).map(
      (step): StepTiming => ({
        label: step.label,
        perIteration: step.perIteration,
        stats: computeStats(step.perIteration),
      }),
    ),
  };
}
