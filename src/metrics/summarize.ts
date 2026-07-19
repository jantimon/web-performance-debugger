import type {
  BenchStats,
  InteractionTiming,
  NormalizedEvent,
  RecordingSummary,
  StepTiming,
} from "../model/recording.js";
import { invalidationKind } from "../trace/classify.js";
import { STYLE_PARSE_NAMES } from "../trace/taxonomy.js";
import { mainThread } from "../trace/main-thread.js";
import { measuredIf, type Measured } from "../model/measured.js";
import { usToMs, msToUs } from "../model/time.js";
import { LONG_TASK_MS, inWindow } from "../trace/analysis.js";
// inWindow is start-onward by design; see the note in analysis.ts.

/** Layout/style counts and durations sourced from the trace, windowed on ONE renderer main thread. */
export interface TraceRenderingWork {
  /** trace `Layout` events on the main thread; equals Blink's `LayoutCount` (one event per increment). */
  layoutCount: number;
  /** trace `UpdateLayoutTree` on the main thread, excluding `ParseAuthorStyleSheet`; equals `RecalcStyleCount`. */
  styleCount: number;
  /** Σ dur of the counted `Layout` events, microseconds. */
  layoutUs: number;
  /** Σ dur of the counted `UpdateLayoutTree` events (parse excluded), microseconds. */
  styleUs: number;
}

/**
 * Sum layout/style counts and durations from the trace alone, on the single renderer main thread the
 * breakdown bar tiles (`thread` from `mainThread`), so a count never scopes to a different thread
 * than its bar. When `thread` is null (every non-breakdown capture strips pid/tid) there is one
 * thread to count and all in-window events are admitted.
 *
 * Counts are exact: Blink emits one trace event per `getMetrics` counter increment, so `layoutCount`
 * equals `LayoutCount` and `styleCount` equals `RecalcStyleCount`, provided the style count excludes
 * `ParseAuthorStyleSheet` (a stylesheet parse is real `style`-slice time but not a recalc, so Blink
 * never counts it). An OOPIF's layout runs on its own renderer process and is filtered out here,
 * never summed into a single main-thread window; it is a separate off-thread per-frame count.
 *
 * Durations (`layoutUs`/`styleUs`) carry the same window/thread/parse exclusion and track CDP
 * `LayoutDuration`/`RecalcStyleDuration` to within ~1% (layout) / a few µs (style) on a light trace.
 * They are wall-tier `base::TimeTicks` ms, valid ONLY on a no-`.stack` trace: the `.stack` category
 * inflates `UpdateLayoutTree` dur up to +38%, so a caller reading a `.stack`/`--deep` trace must not
 * feed these into a reported duration field.
 */
export function traceRenderingWork(
  detailEvents: NormalizedEvent[],
  detailWindowStart: number | null,
  thread: { pid: number; tid: number } | null,
): TraceRenderingWork {
  let layoutCount = 0;
  let layoutUs = 0;
  let styleCount = 0;
  let styleUs = 0;
  for (const event of detailEvents) {
    if (!inWindow(event, detailWindowStart)) continue;
    // Sampled blame annotations are not measured flushes (see the note in buildSummary's loop).
    if (event.sampled) continue;
    if (thread && (event.pid !== thread.pid || event.tid !== thread.tid)) continue;
    if (event.kind === "layout") {
      layoutCount++;
      layoutUs += event.dur;
    } else if (event.kind === "style" && !STYLE_PARSE_NAMES.has(event.name)) {
      styleCount++;
      styleUs += event.dur;
    }
  }
  return { layoutCount, styleCount, layoutUs, styleUs };
}

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

/**
 * What the one capture that ran could observe, per rung/lane. Every count/duration below is gated
 * to `Measured` null vs a number by one of these flags, so a rung that saw no trace reports null
 * (not a fake 0), and a `.stack`/`--deep` trace reports exact counts but suppresses its distorted
 * durations. Computed once in `capabilitiesFor` (record/capture.ts) and threaded to every
 * `buildSummary` call (run, step, node) so one rung's honesty is stated in one place.
 */
export interface CaptureCapabilities {
  /** a trace was captured, so layout/style COUNTS are exact (windowed on the bar's main thread) */
  counts: boolean;
  /** paint COUNT is exact (chrome trace); off on Firefox, where paint is off-main-thread */
  paintCount: boolean;
  /** long-task COUNT is exact (chrome DevTools trace); off on Firefox */
  longTasks: boolean;
  /** invalidation COUNTS are real (invalidationTracking present: --deep / full trace) */
  invalidations: boolean;
  /** slice/derived DURATIONS are trustworthy (light no-`.stack` trace); off on --deep (.stack) */
  durations: boolean;
  /** forced-layout detection ran (.stack, or Firefox marker cause) */
  forced: boolean;
}

/** Everything not-measured: the default/precise-wall rung and node, which capture no rendering work. */
export const NO_RENDERING_CAPTURE: CaptureCapabilities = {
  counts: false,
  paintCount: false,
  longTasks: false,
  invalidations: false,
  durations: false,
  forced: false,
};

export interface SummaryInputs {
  detailEvents: NormalizedEvent[];
  detailWindowStart: number | null;
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
  /** what the capture could observe; defaults to NO_RENDERING_CAPTURE (default rung / node). */
  capabilities?: CaptureCapabilities;
  /** JS self-time from the CPU model, or null (--deep has no sampler, so no CPU model). */
  scriptingMs?: Measured<number>;
}

export function buildSummary(input: SummaryInputs): RecordingSummary {
  const { detailEvents, detailWindowStart } = input;
  const perIteration = input.perIteration ?? [];
  const capabilities = input.capabilities ?? NO_RENDERING_CAPTURE;

  // Layout/style counts and durations are windowed on the bar's main thread, so they are sourced
  // by traceRenderingWork rather than the general loop below (which counts every pid/tid).
  const renderingWork = traceRenderingWork(
    detailEvents,
    detailWindowStart,
    mainThread(detailEvents),
  );

  let paintCount = 0;
  let paintUs = 0;
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
    // Sampled blame annotations (Firefox read-site forced blame) are not measured flushes: they
    // exist for `query blame --forced` only. Counting them would double-count the Reflow/Styles
    // markers, which are the one-per-flush source of layout/style/forced counts and durations.
    if (event.sampled) continue;
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
      // layout/style counts and durations come from traceRenderingWork (main-thread windowed), not
      // this all-pids loop; every kind here derives no inline summary counter. Enumerated (not left
      // to a silent default) so a future EventKind lands on the exhaustiveness guard below and must
      // be handled here.
      case "layout":
      case "style":
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
    // Counts come from the trace, main-thread windowed (renderingWork); a rung with no trace reports
    // null, never a fake 0. Durations ride Chrome's `base::TimeTicks` (wall-tier, ~1%) and are valid
    // only on the light no-`.stack` trace, so a `--deep` (.stack) capture reports the exact counts
    // but null durations -- a distorted number is worse than none (.stack inflates style up to +38%).
    layoutCount: measuredIf(capabilities.counts, renderingWork.layoutCount),
    layoutMs: measuredIf(capabilities.durations, usToMs(renderingWork.layoutUs)),
    styleCount: measuredIf(capabilities.counts, renderingWork.styleCount),
    styleMs: measuredIf(capabilities.durations, usToMs(renderingWork.styleUs)),
    // Main-thread paint chunks only; see PAINT in trace/classify.ts. There is deliberately no
    // composite count: [measured] it tracks --settle duration (7x swing on a constant workload),
    // i.e. frames elapsed, never the page's work. docs/dev/rendering-counts.md.
    paintCount: measuredIf(capabilities.paintCount, paintCount),
    paintMs: measuredIf(capabilities.paintCount && capabilities.durations, usToMs(paintUs)),
    layoutInvalidations: measuredIf(capabilities.invalidations, layoutInval),
    paintInvalidations: measuredIf(capabilities.invalidations, paintInval),
    styleInvalidations: measuredIf(capabilities.invalidations, styleInval),
    // null (not 0) when detection did not run: the default/--breakdown rungs drop the `.stack`
    // category forced detection needs, so a 0 here would read as "no thrashing" instead of "not
    // measured". forcedLayoutMs is additionally a duration, so it is null wherever durations are.
    forcedLayoutCount: measuredIf(capabilities.forced, forcedLayoutCount),
    forcedLayoutMs: measuredIf(
      capabilities.forced && capabilities.durations,
      usToMs(forcedLayoutUs),
    ),
    longTaskCount: measuredIf(capabilities.longTasks, longTaskCount),
    longestTaskMs: measuredIf(
      capabilities.longTasks && capabilities.durations,
      usToMs(longestTaskUs),
    ),
    scriptingMs: input.scriptingMs ?? null,
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
