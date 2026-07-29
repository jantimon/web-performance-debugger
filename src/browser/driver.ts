import { pathToFileURL } from "node:url";
import type { Page } from "puppeteer";
import {
  SETTLE_SOURCE,
  PAINT_FLUSH_SOURCE,
  FRAME_PROBE_SOURCE,
  FRAME_PROBE_FRAMES,
  STALL_CEILING_MS,
} from "./settle.js";
import { frameStallError } from "./launch.js";
import { waitForStable } from "./until.js";
import { duplicateLabelError } from "../trace/steps.js";
import type { DriverStep } from "../model/driver-step.js";
import type {
  EngineSoftNav,
  InteractionTiming,
  LayoutShift,
  LayoutShiftSource,
  LoafFrame,
  NavigationKind,
  SoftNavRoute,
  SoftNavRouteLcp,
  StepLcp,
  StepLoaf,
} from "../model/recording.js";

/**
 * A `timeOrigin` delta above this (ms) is a document reload, below it is measurement jitter: a reload
 * moves `timeOrigin` by far more than jitter, so this cleanly separates a hard navigation from a
 * same-document one (docs/dev/navigation-and-lcp.md, [measured] byte-identical across every soft step).
 */
export const HARD_NAV_ORIGIN_DELTA_MS = 0.5;

/** Whether two URLs differ ONLY in their fragment (`#...`): origin + path + query equal, hash differs. */
function differsOnlyInFragment(beforeUrl: string, afterUrl: string): boolean {
  try {
    const before = new URL(beforeUrl);
    const after = new URL(afterUrl);
    return (
      before.hash !== after.hash &&
      before.origin === after.origin &&
      before.pathname === after.pathname &&
      before.search === after.search
    );
  } catch {
    // A non-parseable URL (about:blank edge cases) cannot be shown to be fragment-only; fall back to
    // plain soft rather than guess.
    return false;
  }
}

/**
 * Classify a driver step's navigation from its own before/after `page.url()` and `timeOrigin` reads --
 * pure, so the rule is unit-testable and CDP-free. The clock is the primary gate: `timeOrigin` is
 * fixed per document, so a moved origin means a NEW document ("hard") even when the URL is unchanged
 * (a reload, a goto to the same URL). With the origin held, the URL splits the rest: unchanged is
 * "none", changed is a same-document route change ("soft"), or "soft-hash" when only the fragment
 * moved. See NavigationKind and docs/dev/navigation-and-lcp.md.
 */
export function classifyNavigation(
  beforeUrl: string,
  afterUrl: string,
  beforeOriginMs: number,
  afterOriginMs: number,
): NavigationKind {
  if (Math.abs(afterOriginMs - beforeOriginMs) > HARD_NAV_ORIGIN_DELTA_MS) return "hard";
  if (beforeUrl === afterUrl) return "none";
  if (differsOnlyInFragment(beforeUrl, afterUrl)) return "soft-hash";
  return "soft";
}

/** One `largest-contentful-paint` entry, serialized in-page (its `element` is a live node). */
export interface RawLcpEntry {
  url: string;
  size: number;
  tag: string;
  id: string;
  className: string;
  renderTimeMs: number;
  loadTimeMs: number;
  startTimeMs: number;
}

/** A `startTime` this far (ms) beyond the step's own window is the built-in-headless anomaly (~60s on
 * a ~40ms page), not real; suppress it rather than print it as fact. Generous, so real variance passes. */
export const LCP_STARTTIME_SLACK_MS = 1000;

/**
 * How long (ms) the end-of-step flush waits IN-PAGE for a racing boot-LCP entry on a hard-nav step
 * whose paint happened but whose entry has not reached the observer yet (a slow compositor queues the
 * entry after the callback the read would otherwise beat). [measured] the entry recovers within ~2
 * frames (<=41ms even under 20x CPU throttle); this budget clears ~20 worst-case 24ms frames, an order
 * of magnitude of headroom, and stays an order of magnitude under the STALL_CEILING_MS backstop. A page
 * with no contentful paint queues nothing, so the wait ends here and absence stays honest. The wait
 * sits AFTER the step's end mark, so it never grows the measured window.
 */
export const LCP_ENTRY_WAIT_MS = 500;

/**
 * Shape the largest observed `largest-contentful-paint` entry into the stored `StepLcp`, keeping only
 * the fields that carry signal. Returns null when nothing was observed (no contentful paint in the
 * window, or no LCP support), so the caller stores nothing rather than a fabricated zero.
 *
 * `boundMs` is the step's own end-of-window page clock (`performance.now()` on the step's final
 * document); when the entry's `startTime` sits implausibly beyond it, the paint clock is the
 * built-in-headless anomaly and the entry is stored `suppressed` with no timing, never a 60s LCP as fact.
 */
export function shapeLcp(raw: RawLcpEntry | undefined, boundMs: number | null): StepLcp | null {
  if (!raw) return null;
  if (boundMs != null && raw.startTimeMs > boundMs + LCP_STARTTIME_SLACK_MS)
    return { suppressed: true };
  const lcp: StepLcp = {};
  if (raw.url) lcp.url = raw.url;
  if (raw.size > 0) lcp.size = raw.size;
  if (raw.tag) lcp.tag = raw.tag;
  if (raw.id) lcp.id = raw.id;
  if (raw.className) lcp.className = raw.className;
  if (raw.renderTimeMs > 0) lcp.renderTimeMs = raw.renderTimeMs;
  if (raw.loadTimeMs > 0) lcp.loadTimeMs = raw.loadTimeMs;
  if (raw.startTimeMs > 0) lcp.startTimeMs = raw.startTimeMs;
  return lcp;
}

/** One `long-animation-frame` entry's script attribution, as read back out of the page. */
export interface RawLoafScript {
  invoker: string;
  invokerType: string;
  sourceURL: string;
  sourceFunctionName: string;
  durationMs: number;
  forcedStyleLayoutMs: number;
}

/** One `long-animation-frame` entry, as read back out of the page. */
export interface RawLoafFrame {
  durationMs: number;
  blockingDurationMs: number;
  scripts: RawLoafScript[];
}

/** One Event Timing entry, as read back out of the page. */
export interface RawEventTiming {
  startTime: number;
  processingStart: number;
  processingEnd: number;
  duration: number;
  /** 0 for events that are not part of an interaction (pointerover, mouseover, ...) */
  interactionId: number;
  /** the entry's `navigationId` (Chrome 151+): the interactions AFTER a soft nav carry the new id, the
   * triggering interaction the pre-nav id, so route INP slices by it. NaN on a build that omits it. */
  navigationId: number;
}

/**
 * Split the worst interaction's latency into the three CWV parts.
 *
 * Group by `interactionId`, take the worst group, then keep only the entries in it that share the
 * group's LONGEST duration. That last step is the subtle one, and skipping it produced nonsense.
 * One interaction can span more than one paint: on a held click (measured, `delay: 250`)
 * `pointerdown` painted at 43.3 with `duration: 24` while `pointerup`/`click` painted at 336.1 with
 * `duration: 64`. Mixing them -- reading `startTime` off `pointerdown` and `duration` off `click` --
 * reported `processingMs: 297.5` and `presentationDelayMs: -241.8` for a 45ms handler.
 *
 * The max-duration entries are the right anchor because `duration` IS the interaction's latency to
 * its paint, and INP is that maximum: describing that journey describes the number being reported.
 * Anchoring on the earliest event instead would price `pointerdown`'s own paint and lose the click
 * handler entirely (15.7ms of a measured 45.3). Durations are 8ms multiples, so equality here needs
 * no epsilon; entries reaching the same paint from starts 0.1ms apart still share one duration
 * (measured: a plain click's pointerdown/pointerup/click all read 64).
 *
 * Non-negative by construction: paintTime is clamped to be >= processingStart, and processingEnd is
 * clamped to be <= paintTime, mirroring the same two guards in web-vitals.
 *
 * Returns null when nothing carries an interactionId. That is not a failure and must not be 0: a
 * programmatic step (`page.evaluate`) fires untrusted events, which Event Timing does not observe at
 * all (measured: zero entries), and an interaction faster than the spec's 16ms floor produces none.
 */
export function interactionBreakdown(entries: RawEventTiming[]): InteractionTiming | null {
  const groups = new Map<number, RawEventTiming[]>();
  for (const entry of entries) {
    if (!entry.interactionId) continue;
    const group = groups.get(entry.interactionId) ?? [];
    group.push(entry);
    groups.set(entry.interactionId, group);
  }
  let worstGroup: RawEventTiming[] | null = null;
  let worstDuration = -1;
  for (const group of groups.values()) {
    const duration = Math.max(...group.map((entry) => entry.duration));
    if (duration > worstDuration) {
      worstDuration = duration;
      worstGroup = group;
    }
  }
  if (!worstGroup) return null;

  // Only the events that reached the paint this interaction is measured by.
  const atWorstPaint = worstGroup.filter((entry) => entry.duration === worstDuration);
  const startTime = Math.min(...atWorstPaint.map((entry) => entry.startTime));
  const processingStart = Math.min(...atWorstPaint.map((entry) => entry.processingStart));
  // max(): a handler that starts after its own frame deadline would otherwise push presentation
  // delay negative. min(): processing cannot outlast the paint it is being measured against.
  const paintTime = Math.max(startTime + worstDuration, processingStart);
  const processingEnd = Math.min(
    Math.max(...atWorstPaint.map((entry) => entry.processingEnd)),
    paintTime,
  );
  return {
    inputDelayMs: processingStart - startTime,
    processingMs: processingEnd - processingStart,
    presentationDelayMs: paintTime - processingEnd,
  };
}

/** Keep the step's LoAF field small: the worst few frames, each naming its worst few scripts. */
export const LOAF_FRAME_CAP = 3;
export const LOAF_SCRIPT_CAP = 5;
/** Scripts shorter than this that forced no style/layout are noise, dropped from a frame's list. */
export const LOAF_SCRIPT_MIN_MS = 0.5;

/**
 * Shape the raw `long-animation-frame` entries observed in a step window into the stored `StepLoaf`.
 *
 * The headline totals (`totalDurationMs`/`totalBlockingMs`/`observedFrames`) count EVERY observed
 * frame, before the cap, so the summary is honest about how much long-frame time the step spent even
 * when only the worst frames keep their script lists. Frames are worst-first by duration; within each,
 * scripts are worst-first by duration and pruned of sub-`LOAF_SCRIPT_MIN_MS` noise that forced no
 * style/layout. Returns null when nothing was observed (the step ran no long frame, OR the browser has
 * no LoAF support), so the caller stores nothing rather than a fabricated zero.
 */
export function summarizeLoaf(rawFrames: RawLoafFrame[]): StepLoaf | null {
  if (!rawFrames.length) return null;
  const totalDurationMs = rawFrames.reduce((sum, frame) => sum + frame.durationMs, 0);
  const totalBlockingMs = rawFrames.reduce((sum, frame) => sum + frame.blockingDurationMs, 0);
  const frames: LoafFrame[] = [...rawFrames]
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, LOAF_FRAME_CAP)
    .map((frame) => ({
      durationMs: frame.durationMs,
      blockingDurationMs: frame.blockingDurationMs,
      scripts: [...frame.scripts]
        .filter(
          (script) => script.durationMs >= LOAF_SCRIPT_MIN_MS || script.forcedStyleLayoutMs > 0,
        )
        .sort((left, right) => right.durationMs - left.durationMs)
        .slice(0, LOAF_SCRIPT_CAP)
        .map((script) => ({
          invoker: script.invoker,
          invokerType: script.invokerType,
          sourceURL: script.sourceURL,
          ...(script.sourceFunctionName ? { sourceFunctionName: script.sourceFunctionName } : {}),
          durationMs: script.durationMs,
          forcedStyleLayoutMs: script.forcedStyleLayoutMs,
        })),
    }));
  return { frames, totalDurationMs, totalBlockingMs, observedFrames: rawFrames.length };
}

/** One layout-shift source rect, as read back out of the page. */
export interface RawLayoutShiftRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One `sources` entry of a `layout-shift`, serialized in-page (its `node` is a live element). */
export interface RawLayoutShiftSource {
  tag: string;
  id: string;
  className: string;
  previousRect: RawLayoutShiftRect | null;
  currentRect: RawLayoutShiftRect | null;
}

/** One `layout-shift` entry, as read back out of the page. */
export interface RawLayoutShiftEntry {
  value: number;
  hadRecentInput: boolean;
  startTimeMs: number;
  sources: RawLayoutShiftSource[];
  /** the entry's `navigationId` (Chrome 151+): a shift AFTER a soft nav carries the new id, so route CLS
   * slices by it. NaN on a build that omits it (route CLS then matches nothing, staying absent). */
  navigationId: number;
}

/** A new session window opens when a shift lands more than this (ms) after the PREVIOUS shift. Spec. */
export const LAYOUT_SHIFT_SESSION_GAP_MS = 1000;
/** ...or more than this (ms) after the window's FIRST shift, whichever comes first. Spec. */
export const LAYOUT_SHIFT_SESSION_MAX_MS = 5000;
/** Keep only the top few shifting elements of the winning window; the rest are a long tail of noise. */
export const LAYOUT_SHIFT_SOURCE_CAP = 3;

function rectArea(rect: RawLayoutShiftRect | null): number {
  if (!rect) return 0;
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

/** A shifted element as `tag#id.firstClass`, lower-cased and truncated; "(anonymous)" when it carried
 * no identity. Built here (not in-page) so the pure function owns the descriptor and stays testable. */
function describeShiftNode(source: RawLayoutShiftSource): string {
  const tag = source.tag ? source.tag.toLowerCase() : "";
  const id = source.id ? `#${source.id}` : "";
  const firstClass = source.className ? source.className.trim().split(/\s+/)[0] : "";
  const cls = firstClass ? `.${firstClass}` : "";
  const label = `${tag}${id}${cls}`;
  return (label || "(anonymous)").slice(0, 60);
}

/**
 * Compute a step's Cumulative Layout Shift from its raw `layout-shift` entries: the spec SESSION-WINDOW
 * MAXIMUM, not a raw sum. Entries flagged `hadRecentInput` are excluded (a shift within 500ms of a user
 * input does not count, per spec). The rest are grouped into session windows -- a new window opens when
 * a shift lands >LAYOUT_SHIFT_SESSION_GAP_MS after the previous shift or >LAYOUT_SHIFT_SESSION_MAX_MS
 * after the window's first -- each window is scored by summing its entries, and `cls` is the largest
 * window's score. A raw sum would be a lookalike that overstates the metric.
 *
 * The winning window's score is then attributed to elements. The API scores an ENTRY, not a source, so
 * an entry's value is split across its sources in proportion to their moved area (a ranking proxy for
 * "which element shifted most", never a spec quantity); each element keeps the rects from its largest
 * occurrence. Returns null when no qualifying shift was observed (no shift, or every shift excluded, or
 * no layout-shift support), so the caller stores nothing rather than a fabricated zero.
 */
export function computeLayoutShift(entries: RawLayoutShiftEntry[]): LayoutShift | null {
  const qualifying = entries
    .filter((entry) => !entry.hadRecentInput && entry.value > 0)
    .sort((left, right) => left.startTimeMs - right.startTimeMs);
  if (!qualifying.length) return null;

  const windows: RawLayoutShiftEntry[][] = [];
  let current: RawLayoutShiftEntry[] = [];
  let windowStartMs = 0;
  let previousMs = 0;
  for (const entry of qualifying) {
    if (
      current.length &&
      (entry.startTimeMs - previousMs > LAYOUT_SHIFT_SESSION_GAP_MS ||
        entry.startTimeMs - windowStartMs > LAYOUT_SHIFT_SESSION_MAX_MS)
    ) {
      windows.push(current);
      current = [];
    }
    if (!current.length) windowStartMs = entry.startTimeMs;
    current.push(entry);
    previousMs = entry.startTimeMs;
  }
  if (current.length) windows.push(current);

  const scored = windows.map((window) => ({
    entries: window,
    score: window.reduce((sum, entry) => sum + entry.value, 0),
  }));
  const winning = scored.reduce((best, window) => (window.score > best.score ? window : best));

  interface NodeTally {
    node: string;
    score: number;
    area: number;
    previousRect?: RawLayoutShiftRect;
    currentRect?: RawLayoutShiftRect;
  }
  const byNode = new Map<string, NodeTally>();
  for (const entry of winning.entries) {
    const weights = entry.sources.map((source) =>
      Math.max(rectArea(source.currentRect), rectArea(source.previousRect)),
    );
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    entry.sources.forEach((source, at) => {
      const node = describeShiftNode(source);
      const share = totalWeight > 0 ? weights[at] / totalWeight : 1 / entry.sources.length;
      const tally = byNode.get(node) ?? { node, score: 0, area: -1 };
      tally.score += entry.value * share;
      // Keep the rects from this element's largest occurrence in the window.
      if (weights[at] > tally.area) {
        tally.area = weights[at];
        if (source.previousRect) tally.previousRect = source.previousRect;
        if (source.currentRect) tally.currentRect = source.currentRect;
      }
      byNode.set(node, tally);
    });
  }
  const sources: LayoutShiftSource[] = [...byNode.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, LAYOUT_SHIFT_SOURCE_CAP)
    .map((tally) => ({
      node: tally.node,
      score: tally.score,
      ...(tally.previousRect ? { previousRect: tally.previousRect } : {}),
      ...(tally.currentRect ? { currentRect: tally.currentRect } : {}),
    }));
  return {
    cls: winning.score,
    windowCount: windows.length,
    shiftCount: winning.entries.length,
    sources,
  };
}

/**
 * One `soft-navigation` entry, read back out of the page at the end-of-step flush (NOT eagerly in the
 * observer callback): the route's LICP identity is read then, off the retained live entry's
 * `getLargestInteractionContentfulPaint()`, so a paint that grows after the entry fires is still caught.
 */
export interface RawSoftNavEntry {
  /** the route's URL (`entry.name`) */
  url: string;
  /** "push" or "replace": the history op the engine attributed */
  navigationType: string;
  /** the numeric `navigationId` per-soft-step metrics slice by */
  navigationId: number;
  /** the `interactionId` of the trusted interaction the engine tied the route to */
  interactionId: number;
  /** the route's time origin (`entry.startTime`), the clock every route metric anchors to */
  startTimeMs: number;
  /** the route LICP's resource url (`...largestContentfulPaint.url`); "" for a text paint or no paint */
  lcpUrl: string;
  /** the route LICP's intrinsic size (px^2); 0 when none */
  lcpSize: number;
  /** the route LICP element's tag (e.g. "IMG", "P"); "" when none */
  lcpTag: string;
  /** the route LICP's `renderTime` on the document clock; 0 when TAO-gated or no paint */
  lcpRenderTimeMs: number;
}

/**
 * Shape a soft nav entry's route LICP into the stored `SoftNavRouteLcp`, anchoring the paint time to the
 * route's `startTime` (the route clock). Returns null when the entry carried no largest-interaction-
 * contentful-paint identity AND no usable render time (no route paint observed yet), so the caller omits
 * `routeLcp`. A TAO-gated paint keeps its identity but drops `routeMs` (its renderTime reads 0 by spec).
 */
function shapeSoftNavRouteLcp(entry: RawSoftNavEntry): SoftNavRouteLcp | null {
  const hasIdentity = !!entry.lcpUrl || !!entry.lcpTag || entry.lcpSize > 0;
  const routeMs =
    entry.lcpRenderTimeMs > 0 && entry.lcpRenderTimeMs >= entry.startTimeMs
      ? entry.lcpRenderTimeMs - entry.startTimeMs
      : null;
  if (!hasIdentity && routeMs == null) return null;
  const routeLcp: SoftNavRouteLcp = {};
  if (routeMs != null) routeLcp.routeMs = routeMs;
  if (entry.lcpTag) routeLcp.tag = entry.lcpTag;
  if (entry.lcpUrl) routeLcp.url = entry.lcpUrl;
  if (entry.lcpSize > 0) routeLcp.size = entry.lcpSize;
  return routeLcp;
}

/**
 * Shape a soft-navigating step's route-transition metrics from the raw entries observed in its window:
 * the engine `soft-navigation` entries, the step's `layout-shift` entries, and its `event`-timing
 * entries. Keys strictly on the engine's verdict -- returns null when no `soft-navigation` entry fired,
 * since only that entry carries a `navigationId` to slice the metrics by. Pure, so the slicing rules are
 * unit-testable without a browser.
 *
 * - Route LCP: the FIRST soft nav's `getLargestInteractionContentfulPaint()`, on the route clock.
 * - Route CLS: the `layout-shift` entries carrying the route's `navigationId` (the post-route shifts),
 *   scored by the same spec session-window maximum as boot CLS (`computeLayoutShift`).
 * - Route INP: the `event`-timing entries carrying the route's `navigationId` (the post-route
 *   interactions). The interaction that TRIGGERED the soft nav carries the PRE-nav id, so slicing by the
 *   route id excludes it -- it stays in the step's main `inpMs`.
 *
 * A non-finite `navigationId` (a build that did not populate it) matches nothing, so route CLS/INP stay
 * absent rather than folding pre-nav work in. When more than one soft nav fired, the FIRST is reported
 * and the rest counted in `additionalSoftNavs`, never averaged into a synthetic route.
 */
export function shapeSoftNavRoute(
  softNavs: RawSoftNavEntry[],
  layoutShifts: RawLayoutShiftEntry[],
  events: RawEventTiming[],
): SoftNavRoute | null {
  if (!softNavs.length) return null;
  const [first, ...rest] = softNavs;
  const navigationId = first.navigationId;
  const route: SoftNavRoute = {
    navigationId,
    navigationType: first.navigationType,
    ...(first.url ? { url: first.url } : {}),
  };
  const routeLcp = shapeSoftNavRouteLcp(first);
  if (routeLcp) route.routeLcp = routeLcp;
  if (Number.isFinite(navigationId)) {
    const routeShifts = layoutShifts.filter((entry) => entry.navigationId === navigationId);
    const routeCls = computeLayoutShift(routeShifts);
    if (routeCls) route.routeCls = routeCls;
    const routeEvents = events.filter((entry) => entry.navigationId === navigationId);
    const routeInpMs = routeEvents.length
      ? Math.max(...routeEvents.map((entry) => entry.duration))
      : null;
    if (routeInpMs != null) route.routeInpMs = routeInpMs;
    const routeInteraction = interactionBreakdown(routeEvents);
    if (routeInteraction) route.routeInteraction = routeInteraction;
  }
  if (rest.length) route.additionalSoftNavs = rest.length;
  return route;
}

/**
 * Shape the raw `soft-navigation` entries observed in a step's window into the stored `EngineSoftNav`,
 * Chrome's own verdict beside the url+timeOrigin classifier. Returns null when none fired (no support,
 * or no trusted-interaction route in the window), so the caller stores nothing rather than a fabricated
 * zero -- absence stays absence. Keeps only the fields per-soft-step metrics slice by: the history op,
 * the numeric navigationId, and the interaction the engine tied the route to; each id array is dropped
 * when the build populated none of it.
 */
export function shapeEngineSoftNav(raw: RawSoftNavEntry[]): EngineSoftNav | null {
  if (!raw.length) return null;
  const navigationTypes = raw.map((entry) => entry.navigationType).filter((type) => !!type);
  const navigationIds = raw.map((entry) => entry.navigationId).filter((id) => Number.isFinite(id));
  const interactionIds = raw
    .map((entry) => entry.interactionId)
    .filter((id) => Number.isFinite(id) && id > 0);
  return {
    count: raw.length,
    navigationTypes,
    ...(navigationIds.length ? { navigationIds } : {}),
    ...(interactionIds.length ? { interactionIds } : {}),
  };
}

/** A timed iteration failed partway and --keep-partial salvaged the ones that completed. */
export interface PartialRun {
  /** iterations the caller asked for */
  requested: number;
  /** iterations that ran run() to completion (and whose steps are kept) */
  completed: number;
  /** 0-based index of the iteration that threw */
  failedIteration: number;
  /** label of the measureStep in progress when it threw, or null (it failed between steps) */
  failedStep: string | null;
  /** the thrown error's message */
  reason: string;
}

export interface DriverResult {
  steps: DriverStep[];
  lifecycle: string[];
  /** teardown to run AFTER tracing stops, so it's kept out of the measured window */
  cleanup?: () => unknown | Promise<unknown>;
  /** set when --keep-partial salvaged a run whose later iteration failed */
  partial?: PartialRun;
}

export interface DriverOptions {
  /** timed repetitions of run(); each re-measures every step and appends a wall sample */
  iterations: number;
  /** untimed repetitions of run() before the timed loop, excluded from marks/counters/samples */
  warmup: number;
  /**
   * Keep the iterations that completed when a LATER one fails, instead of aborting the whole run.
   * Only salvages when at least one full iteration completed; a failure in iteration 0 (a broken
   * flow) still throws. The failed iteration's partial steps are discarded and disclosed loudly.
   */
  keepPartial?: boolean;
}

/** "Step is done" override: a selector to wait for, a predicate/async fn, or a promise. */
export type Until = string | (() => unknown | Promise<unknown>) | Promise<unknown> | undefined;

interface StepOpts {
  until?: Until;
}

/** Define one measured step, `measureStep(label, action, { until })` or the config-object form. */
export interface MeasureStep {
  (label: string, action: () => unknown, opts?: StepOpts): Promise<void>;
  (config: { label: string; action: () => unknown; until?: Until }): Promise<void>;
}

/**
 * The argument driver mode hands `prepare`/`run`/`cleanup`. `waitForStable` is injected so a driver
 * module needs NO import from the package (it does not resolve under a bare `npx` run, whose cwd has
 * no node_modules for the package): `until: waitForStable(page, { selector, quietMs })`. The injected
 * helper is the same function the package exports, so the two forms are interchangeable.
 */
export interface DriverContext {
  /** The Puppeteer page under test; drive it (click, type, goto) inside a measureStep action. */
  page: Page;
  /** Empty object shared across prepare/run/cleanup: stash a handle or test data in prepare, read it
   * in run. */
  ctx: Record<string, unknown>;
  measureStep: MeasureStep;
  /** A `measureStep` `until` for streamed / soft-navigating transitions the default settle ends
   * before. Injected so the module imports nothing; identical to the package's `waitForStable`. */
  waitForStable: typeof waitForStable;
}

/**
 * The built-in on-ramp flow (no user module): navigate to `navigateUrl` inside one measured step so
 * the page's own boot lands in the run window (goto-inside-a-step tracing). See docs/dev/driver-timing.md.
 */
export interface OnrampFlow {
  navigateUrl: string;
  /**
   * Inspect the settled page for a bot-challenge interstitial, run ONCE right after the first
   * navigation (the built-in load step's own goto), before the timed measurement continues. Throws a
   * BotWallError to refuse a wall; the driver lets it propagate so record aborts with no artifact.
   */
  afterFirstLoad?: () => Promise<void>;
}

/**
 * Driver (puppeteer) mode: the user's module runs in Node and `run` receives
 * `{ page, ctx, measureStep }`. Define each step with:
 *
 *   await measureStep('label', () => page.click('#x'))
 *   await measureStep({ label, action, until })
 *
 * Each step is wrapped in wpd:step:N marks, settled (or awaited via
 * `until`), and assigned a per-step INP. Per-step rendering counts come from the trace window this
 * pass captures (--breakdown/--deep), not from CDP: there is one pass, and the counters are gone.
 */
export async function runDriver(
  page: Page,
  absModule: string | undefined,
  fnName: string,
  options: DriverOptions = { iterations: 1, warmup: 0 },
  onramp?: OnrampFlow,
  beforeRunWindow?: () => Promise<void>,
): Promise<DriverResult> {
  let run: (arg: any) => unknown;
  let prepare: ((arg: any) => unknown) | undefined;
  let cleanup: ((arg: any) => unknown) | undefined;
  if (onramp) {
    // Built-in flow: one "load" step that navigates to the target. No prepare/cleanup. The default
    // settle (rAF+idle, twice) flushes the boot's paints after the load event, so the window is the
    // page's own load-to-settle. A navigating step has a null page-clock wall (the two marks sit on
    // documents with different timeOrigins); a trace capture mode prices it off the trace window instead.
    run = ({
      measureStep,
    }: {
      measureStep: (label: string, action: () => unknown) => Promise<void>;
    }) =>
      measureStep("load", () =>
        page.goto(onramp.navigateUrl, { waitUntil: "load", timeout: 30000 }),
      );
  } else {
    if (!absModule)
      throw new Error("runDriver needs a module path unless a built-in flow is provided.");
    const mod: any = await import(pathToFileURL(absModule).href);
    const pick = (...names: string[]) => {
      for (const name of names) if (typeof mod[name] === "function") return mod[name];
      return undefined;
    };
    run = pick(fnName, "run") ?? (typeof mod.default === "function" ? mod.default : undefined);
    if (!run) throw new Error(`Driver module has no '${fnName}' / 'run' / default export.`);
    prepare = pick("prepare", "setup", "beforeAll");
    cleanup = pick("cleanup", "teardown", "afterAll");
  }

  const lifecycle: string[] = [];
  if (prepare) lifecycle.push("prepare");
  lifecycle.push("run");
  if (cleanup) lifecycle.push("cleanup");

  const mark = (markName: string) => page.evaluate((name) => performance.mark(name), markName);
  // Emit a step's edge mark AND read the page's own clock at that instant: `now` is
  // `performance.now()` (the page-clock timestamp of the mark) and `origin` is `timeOrigin` (which
  // changes on navigation, so a step that navigated is detectable and its page-clock wall refused).
  const stepClock = (markName: string) =>
    page.evaluate((name) => {
      performance.mark(name);
      return { now: performance.now(), origin: performance.timeOrigin };
    }, markName) as Promise<{ now: number; origin: number }>;
  // Both waits are bounded in-page: if the compositor's BeginFrame source has stalled (rAF never
  // fires, a browser-wide headless failure), the evaluate resolves { stalled: true } at the ceiling
  // and we throw a frameStallError, which record.ts's retryTransientNav relaunches on a fresh browser.
  // Without the ceiling an rAF-based settle would hang to the 180s protocol timeout.
  const settle = async () => {
    const outcome = await page.evaluate(SETTLE_SOURCE, STALL_CEILING_MS);
    if (outcome.stalled) throw frameStallError(STALL_CEILING_MS);
  };
  const paintFlush = async () => {
    const outcome = await page.evaluate(PAINT_FLUSH_SOURCE, STALL_CEILING_MS);
    if (outcome.stalled) throw frameStallError(STALL_CEILING_MS);
  };

  // Observe interaction event-timing so we can attribute INP per step. Installed via
  // evaluateOnNewDocument so it re-arms on every navigation (a step that navigates would
  // otherwise wipe the observer and lose INP for all later steps). durationThreshold:16
  // is the spec floor for 'event'; sub-16ms interactions are not reported by the API.
  const installInpObserver = () => {
    const win = window as any;
    win.__cpInp = [];
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const event = entry as any;
          // The whole entry, not just duration: processingStart/End are what split the latency into
          // input delay / processing / presentation, and unlike duration they are not rounded to 8ms.
          win.__cpInp.push({
            startTime: event.startTime,
            processingStart: event.processingStart,
            processingEnd: event.processingEnd,
            duration: event.duration,
            interactionId: event.interactionId ?? 0,
            // navigationId slices route INP: post-soft-nav interactions carry the new id, the triggering
            // one the pre-nav id. NaN where the build omits it, so route INP matches nothing there.
            navigationId: typeof event.navigationId === "number" ? event.navigationId : NaN,
          });
        }
      }).observe({ type: "event", durationThreshold: 16, buffered: true } as any);
    } catch {
      /* event-timing unsupported */
    }
  };
  await page.evaluateOnNewDocument(installInpObserver);
  await page.evaluate(installInpObserver);

  // Observe Long Animation Frames so we can attribute a step's slow frames to the scripts the browser
  // blamed. Same re-arm-on-navigation install as the INP observer. Chrome-only: `supportedEntryTypes`
  // gates it, so on Firefox `win.__cpLoaf` stays [] and the step stores no loaf (never a fake zero).
  // A `PerformanceScriptTiming`'s fields must be read explicitly: its `toJSON()` returns {}.
  const installLoafObserver = () => {
    const win = window as any;
    win.__cpLoaf = [];
    const supported =
      typeof PerformanceObserver !== "undefined" &&
      (PerformanceObserver.supportedEntryTypes || []).includes("long-animation-frame");
    if (!supported) return;
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const frame = entry as any;
          win.__cpLoaf.push({
            durationMs: frame.duration,
            blockingDurationMs: frame.blockingDuration,
            scripts: (frame.scripts || []).map((script: any) => ({
              invoker: script.invoker || "",
              invokerType: script.invokerType || "",
              sourceURL: script.sourceURL || "",
              sourceFunctionName: script.sourceFunctionName || "",
              durationMs: script.duration,
              forcedStyleLayoutMs: script.forcedStyleAndLayoutDuration || 0,
            })),
          });
        }
      }).observe({ type: "long-animation-frame", buffered: true } as any);
    } catch {
      /* long-animation-frame unsupported */
    }
  };
  await page.evaluateOnNewDocument(installLoafObserver);
  await page.evaluate(installLoafObserver);

  // Observe Largest Contentful Paint so a step that booted a fresh document can attribute its boot LCP.
  // Same re-arm-on-navigation install as the other two observers: LCP entries are per document, so a
  // cross-document navigation starts a fresh stream the re-armed observer picks up. `buffered: true`
  // replays the entries that fired before the observer registered. Keep the WHOLE stream; the last
  // entry is the largest (each LCP entry supersedes the previous). Cross-browser Baseline, so unlike
  // LoAF this is not Chrome-gated; a browser without support leaves `win.__cpLcp` [] and stores nothing.
  const installLcpObserver = () => {
    const win = window as any;
    win.__cpLcp = [];
    const supported =
      typeof PerformanceObserver !== "undefined" &&
      (PerformanceObserver.supportedEntryTypes || []).includes("largest-contentful-paint");
    if (!supported) return;
    const shape = (paint: any) => {
      const element = paint.element;
      const className = element && typeof element.className === "string" ? element.className : "";
      return {
        url: paint.url || "",
        size: paint.size || 0,
        tag: element && element.tagName ? element.tagName : "",
        id: paint.id || "",
        className: className.slice(0, 80),
        renderTimeMs: paint.renderTime || 0,
        loadTimeMs: paint.loadTime || 0,
        startTimeMs: paint.startTime || 0,
      };
    };
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) win.__cpLcp.push(shape(entry));
      });
      observer.observe({ type: "largest-contentful-paint", buffered: true } as any);
      // The buffered entry can be QUEUED to the observer before its callback is dispatched: on a slow
      // compositor the end-of-step flush can read __cpLcp before that dispatch, seeing a race-empty
      // list on a step that genuinely painted. takeRecords() delivers the queued entries synchronously
      // through the same shaper, so the flush can drain them rather than miss the paint.
      win.__cpLcpDrain = () => {
        for (const entry of observer.takeRecords()) win.__cpLcp.push(shape(entry));
      };
    } catch {
      /* largest-contentful-paint unsupported */
    }
  };
  await page.evaluateOnNewDocument(installLcpObserver);
  await page.evaluate(installLcpObserver);

  // Observe layout shifts so a step can report CLS (the spec session-window maximum) with the shifting
  // elements attributed. Same re-arm-on-navigation install as the other observers. Chrome-only:
  // `supportedEntryTypes` gates it, so on Firefox `win.__cpLs` stays [] and the step stores no CLS
  // (never a fake zero). A `layout-shift` entry is NOT replayed through `getEntriesByType` (measured:
  // the performance timeline buffer is empty for it), so the observer is the only way to read it; each
  // source's `node`/`previousRect`/`currentRect` are read explicitly into a serializable shape.
  const installLayoutShiftObserver = () => {
    const win = window as any;
    win.__cpLs = [];
    const supported =
      typeof PerformanceObserver !== "undefined" &&
      (PerformanceObserver.supportedEntryTypes || []).includes("layout-shift");
    if (!supported) return;
    const rect = (domRect: any) =>
      domRect ? { x: domRect.x, y: domRect.y, width: domRect.width, height: domRect.height } : null;
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as any;
          win.__cpLs.push({
            value: shift.value || 0,
            hadRecentInput: !!shift.hadRecentInput,
            startTimeMs: shift.startTime,
            // navigationId slices route CLS: a shift after a soft nav carries the new id. NaN where the
            // build omits it, so route CLS matches nothing there (absent, never folding pre-nav shifts).
            navigationId: typeof shift.navigationId === "number" ? shift.navigationId : NaN,
            sources: (shift.sources || []).map((source: any) => {
              const node = source.node;
              return {
                tag: node && node.tagName ? node.tagName : "",
                id: node && node.id ? node.id : "",
                className:
                  node && typeof node.className === "string" ? node.className.slice(0, 80) : "",
                previousRect: rect(source.previousRect),
                currentRect: rect(source.currentRect),
              };
            }),
          });
        }
      }).observe({ type: "layout-shift", buffered: true } as any);
    } catch {
      /* layout-shift unsupported */
    }
  };
  await page.evaluateOnNewDocument(installLayoutShiftObserver);
  await page.evaluate(installLayoutShiftObserver);

  // Observe Chrome's own soft-navigation heuristic so a step carries the engine's verdict BESIDE the
  // url+timeOrigin classifier AND its route-transition metrics. Same re-arm-on-navigation install as the
  // other observers. OPPORTUNISTIC: `supportedEntryTypes` gates registration, so an older Chrome or
  // Firefox (no `soft-navigation` type) leaves the retained list [] and the step stores nothing (never a
  // fake zero, never a forced `--enable-features`). The entry is default-on from Chrome 151.
  //
  // The live entry objects are RETAINED (`win.__cpSoftNavEntries`), not serialized in the callback,
  // because the route's largest paint is read at the end-of-step flush off each entry's
  // `getLargestInteractionContentfulPaint()`: reading in the callback would freeze it at the FCP the
  // entry fires on and miss a larger paint that lands after. `win.__cpSoftNavRead()` produces the
  // serialized `RawSoftNavEntry[]` (route URL, history op, ids, startTime, and the LICP identity) at
  // flush time; `win.__cpSoftNavDrain()` delivers a queued entry synchronously, the same race the LCP
  // observer guards (an entry can be queued before its callback dispatches).
  const installSoftNavObserver = () => {
    const win = window as any;
    win.__cpSoftNavEntries = [];
    const supported =
      typeof PerformanceObserver !== "undefined" &&
      (PerformanceObserver.supportedEntryTypes || []).includes("soft-navigation");
    if (!supported) return;
    const readEntry = (softNav: any) => {
      const licp =
        typeof softNav.getLargestInteractionContentfulPaint === "function"
          ? softNav.getLargestInteractionContentfulPaint()
          : null;
      const paint = licp && licp.largestContentfulPaint ? licp.largestContentfulPaint : null;
      const element = paint && paint.element;
      return {
        url: softNav.name || "",
        navigationType: softNav.navigationType || "",
        navigationId: typeof softNav.navigationId === "number" ? softNav.navigationId : NaN,
        interactionId: typeof softNav.interactionId === "number" ? softNav.interactionId : NaN,
        startTimeMs: softNav.startTime || 0,
        lcpUrl: paint ? paint.url || "" : "",
        lcpSize: paint ? paint.size || 0 : 0,
        lcpTag: element && element.tagName ? element.tagName : "",
        lcpRenderTimeMs: paint ? paint.renderTime || 0 : 0,
      };
    };
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) win.__cpSoftNavEntries.push(entry);
      });
      observer.observe({ type: "soft-navigation", buffered: true } as any);
      win.__cpSoftNavDrain = () => {
        for (const entry of observer.takeRecords()) win.__cpSoftNavEntries.push(entry);
      };
      win.__cpSoftNavRead = () =>
        (win.__cpSoftNavEntries as any[]).map((entry) => readEntry(entry));
    } catch {
      /* soft-navigation unsupported */
    }
  };
  await page.evaluateOnNewDocument(installSoftNavObserver);
  await page.evaluate(installSoftNavObserver);

  // Frame-health gate, before any user action. Chrome's built-in headless can come up with a dead
  // compositor BeginFrame source (permanent, browser-wide), which would hang ANY rAF-based wait in
  // the flow -- a settle, or a user `page.waitForFunction` whose default polling is rAF -- to the
  // 180s protocol timeout, an error the retry cannot classify. The stall shows by the second frame
  // after a load [measured], so probing a few frames here converts a born-dead browser into a
  // retryable frame-stall error that record relaunches on a fresh browser, before the flow can hang
  // on it. Mid-run deaths (e.g. a later navigation) are caught by each step's bounded settle.
  const frameHealth = await page.evaluate(FRAME_PROBE_SOURCE, STALL_CEILING_MS, FRAME_PROBE_FRAMES);
  if (frameHealth.stalled) throw frameStallError(STALL_CEILING_MS);

  async function waitDone(until: Until): Promise<void> {
    if (until == null) return void (await settle());
    if (typeof until === "string") await page.waitForSelector(until);
    else if (typeof until === "function") await (until as () => unknown)();
    else if (typeof (until as Promise<unknown>).then === "function") await until;
    else return void (await settle());
    await paintFlush();
  }

  const steps: DriverStep[] = [];
  // Labels must be unique within ONE iteration, not within the run: a repeated flow measures
  // "mount" once per iteration, and those are the samples, not a collision. Reset per iteration.
  let usedLabels = new Set<string>();
  let indexInIteration = 0;
  let markIndex = 0;
  let iteration = 0;
  let phase: "prepare" | "timed" = "prepare";
  // Where each iteration's `index` counter restarts. prepare() may measure steps too, and those
  // keep the low indices for the whole run; resetting to 0 instead would give the first run step
  // the same index as a prepare step, and `window.measure` (built from index) would then name a
  // mark belonging to the other one.
  let timedIndexBase = 0;
  // Warmup runs the flow for its side effects only (JIT, caches, first-paint work), so steps are
  // executed but not marked, snapshotted or recorded.
  let recording = true;
  // cleanup() is deliberately called by record.ts AFTER tracing stops, so a step measured there
  // can never have a trace window; see the throw in measure().
  let inCleanup = false;
  // The measureStep in progress, for --keep-partial's disclosure: which step an iteration died on.
  // Set before the action runs, cleared once the step is recorded; null means "between steps".
  let activeStepLabel: string | null = null;

  async function measure(label: string, action: () => unknown, until: Until): Promise<void> {
    if (inCleanup) {
      throw new Error(
        `measureStep(${JSON.stringify(label)}) cannot be used in cleanup(): teardown runs after ` +
          `tracing has stopped, so the step is never traced and its layout/paint/forced-layout ` +
          `counts would all read 0 as if it were clean. Measure it in run() instead.`,
      );
    }
    if (!recording) {
      // Warmup: do the work, measure nothing. The action still runs because the flow's later
      // steps depend on it having happened.
      await action();
      await waitDone(until);
      return;
    }
    // Fail here rather than at the cross-pass merge: this fires on the offending call, before
    // the rest of the flow and the second pass have run.
    if (usedLabels.has(label)) throw duplicateLabelError(label);
    usedLabels.add(label);
    activeStepLabel = label;
    const index = indexInIteration++;
    const stepMark = markIndex++;
    await page.evaluate(() => {
      (window as any).__cpInp = [];
      (window as any).__cpLoaf = [];
      (window as any).__cpLcp = [];
      (window as any).__cpLs = [];
      (window as any).__cpSoftNavEntries = [];
    });
    const startClock = await stepClock(`wpd:step:${stepMark}:start`);
    // page.url() is CDP-free (Puppeteer reads it off the page handle). Read it at both marks so the
    // step's navigation is decidable without a browser flag; each step's pair is self-contained (a
    // replaceState can fire between steps, so the end URL is not assumed to be the next start URL).
    const beforeUrl = page.url();
    await action();
    await waitDone(until);
    const endClock = await stepClock(`wpd:step:${stepMark}:end`);
    const afterUrl = page.url();
    const navigation = classifyNavigation(beforeUrl, afterUrl, startClock.origin, endClock.origin);
    // The page's own view of [start mark, end mark]. Null across a navigation (the two marks are on
    // documents with different timeOrigins, so their performance.now() delta is not one interval);
    // record.ts upgrades this to the trace-clock window when a trace was captured.
    const pageWallMs = startClock.origin === endClock.origin ? endClock.now - startClock.now : null;
    // Event-Timing entries reach the observer on a later task, after the frame is
    // presented. Flush a frame + a macrotask so a slow interaction's entry lands before
    // we read it, rather than being dropped or misattributed to the next step. null
    // (not 0) means "no interaction measured"; keep them distinct.
    // LoAF entries land on a later task too, so read them in the same frame+macrotask flush as the
    // Event-Timing entries: one round trip, both signals settled.
    const flushed = (await page.evaluate(
      (ceilingMs, waitLcp, waitSoftNav, entryBudgetMs) =>
        new Promise<{
          inp: RawEventTiming[];
          loaf: RawLoafFrame[];
          lcp: RawLcpEntry[];
          ls: RawLayoutShiftEntry[];
          softNav: RawSoftNavEntry[];
        }>((resolve) => {
          const win = window as any;
          const drainLcp = () => {
            if (typeof win.__cpLcpDrain === "function") win.__cpLcpDrain();
          };
          const drainSoftNav = () => {
            if (typeof win.__cpSoftNavDrain === "function") win.__cpSoftNavDrain();
          };
          const read = () => ({
            inp: (win.__cpInp as RawEventTiming[]) ?? [],
            loaf: (win.__cpLoaf as RawLoafFrame[]) ?? [],
            lcp: (win.__cpLcp as RawLcpEntry[]) ?? [],
            ls: (win.__cpLs as RawLayoutShiftEntry[]) ?? [],
            // The route LICP is read HERE (at the flush), off the retained live entries, so a paint that
            // grew after the soft-nav entry fired is caught. `__cpSoftNavRead` is absent where the entry
            // type is unsupported, so the list reads [] and the step stores no route metrics.
            softNav:
              typeof win.__cpSoftNavRead === "function"
                ? (win.__cpSoftNavRead() as RawSoftNavEntry[])
                : [],
          });
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            drainLcp();
            drainSoftNav();
            resolve(read());
          };
          // The settle already threw on a stalled compositor, so rAF normally fires here; the
          // ceiling is a backstop that reads whatever landed rather than hanging if it does not.
          setTimeout(finish, ceilingMs);
          // Base flush: one frame + a macrotask so INP/LoAF land. Two racing entries can be queued to
          // their observer before its callback dispatches: a hard-nav step's boot LCP, and a soft-nav
          // step's `soft-navigation` entry (whose route LICP the metrics need). For each, drain
          // takeRecords() and, while still race-empty, wait bounded frames for the entry to queue. A step
          // that produced neither (no contentful paint, no engine route) queues nothing, so the wait ends
          // at entryBudgetMs and absence stays honest. A step is hard XOR soft, so at most one arms. All
          // of this sits after the end mark, so it never grows the measured window.
          const canWaitLcp = waitLcp && typeof win.__cpLcpDrain === "function";
          const canWaitSoftNav = waitSoftNav && typeof win.__cpSoftNavDrain === "function";
          let entryWaitStartMs = -1;
          const settleRead = () => {
            if (done) return;
            drainLcp();
            drainSoftNav();
            const needLcp = canWaitLcp && (win.__cpLcp as RawLcpEntry[]).length === 0;
            const needSoftNav =
              canWaitSoftNav && (win.__cpSoftNavEntries as unknown[]).length === 0;
            if (needLcp || needSoftNav) {
              if (entryWaitStartMs < 0) entryWaitStartMs = performance.now();
              if (performance.now() - entryWaitStartMs < entryBudgetMs) {
                requestAnimationFrame(settleRead);
                return;
              }
            }
            finish();
          };
          requestAnimationFrame(() => setTimeout(settleRead, 0));
        }),
      STALL_CEILING_MS,
      navigation === "hard",
      navigation === "soft" || navigation === "soft-hash",
      LCP_ENTRY_WAIT_MS,
    )) as {
      inp: RawEventTiming[];
      loaf: RawLoafFrame[];
      lcp: RawLcpEntry[];
      ls: RawLayoutShiftEntry[];
      softNav: RawSoftNavEntry[];
    };
    const observed = flushed.inp;
    const loaf = summarizeLoaf(flushed.loaf);
    // The engine's own soft-navigation verdict for this window, opportunistic and beside `navigation`:
    // present only where Chrome fired an entry (a trusted-interaction route on 151+), null otherwise.
    const engineSoftNav = shapeEngineSoftNav(flushed.softNav);
    // The route-transition metrics (LCP-equivalent / CLS / INP on the route clock) for a step the engine
    // soft-navigated, keyed by the soft nav's navigationId. Null where the engine fired no entry (a
    // programmatic/untrusted route, older Chrome, Firefox), so it keys strictly on the engine's verdict.
    const softNav = shapeSoftNavRoute(flushed.softNav, flushed.ls, flushed.inp);
    // CLS: the spec session-window maximum over the shifts observed in this step's window, with the
    // shifting elements attributed. Chrome-only (the observer stays empty on Firefox); a step with no
    // qualifying shift stores nothing (null), never a fake 0. The boot/load step is where it shows: a
    // shift within 500ms of a user input is excluded by hadRecentInput, so a click step usually has none.
    const layoutShift = computeLayoutShift(flushed.ls);
    // LCP attaches ONLY to a step that started a fresh document (a hard navigation, which includes the
    // built-in load step): LCP freezes at the first trusted interaction and never re-fires on a soft
    // navigation, so a per-soft-step LCP would be structurally empty. The last entry is the largest.
    // The bound for the anomaly check is the step's own end-of-window page clock (endClock.now, on the
    // post-navigation document, the same clock LCP's startTime rides).
    const lcp =
      navigation === "hard" ? shapeLcp(flushed.lcp[flushed.lcp.length - 1], endClock.now) : null;
    // INP stays max-over-every-entry, deliberately: Chrome emits the whole pointer sequence with
    // every entry sharing one duration to the same next paint, and Firefox emits only the events
    // that did work, so this finds the interaction's latency in both. Verified in both engines:
    // docs/dev/gecko-profile-format.md. The breakdown below needs the interactionId grouping the
    // spec defines; the headline does not, and narrowing it here would change a measured behaviour
    // for no gain.
    const inp = observed.length ? Math.max(...observed.map((entry) => entry.duration)) : null;
    const interaction = interactionBreakdown(observed);
    steps.push({
      index,
      iteration,
      phase,
      markIndex: stepMark,
      label,
      wallMs: pageWallMs,
      ...(pageWallMs != null ? { wallClock: "page" as const } : {}),
      pageWallMs,
      inpMs: inp,
      interaction,
      ...(loaf ? { loaf } : {}),
      navigation,
      beforeUrl,
      afterUrl,
      ...(engineSoftNav ? { engineSoftNav } : {}),
      ...(softNav ? { softNav } : {}),
      ...(lcp ? { lcp } : {}),
      ...(layoutShift ? { layoutShift } : {}),
    });
    activeStepLabel = null;
  }

  // measureStep('label', fn, {until})  OR  measureStep({label, action, until})
  function measureStep(
    labelOrConfig: string | { label: string; action: () => unknown; until?: Until },
    action?: () => unknown,
    opts?: StepOpts,
  ): Promise<void> {
    if (typeof labelOrConfig === "string") return measure(labelOrConfig, action!, opts?.until);
    return measure(labelOrConfig.label, labelOrConfig.action, labelOrConfig.until);
  }

  const ctx: Record<string, unknown> = {};
  // One arg object for every hook. ctx is the same reference throughout, so a handle prepare() stashes
  // is visible in run()/cleanup(). waitForStable is injected so the module needs no package import.
  const driverArg: DriverContext = { page, ctx, measureStep, waitForStable };
  if (prepare) await prepare(driverArg);
  // Anything prepare() measured owns indices 0..n-1 permanently; the timed loop starts after them
  // and restarts there every iteration, so a label's index is the same in every iteration.
  phase = "timed";
  timedIndexBase = indexInIteration;

  // Bot-wall detection runs ONCE, right after the first navigation lands (the built-in load step's
  // goto), before any timed measurement. A wall throws a BotWallError that propagates out of runDriver
  // to abort the whole record. The first navigation is the first run() call: a warmup iteration when
  // --warmup > 0, else timed iteration 0.
  let onrampInspected = false;
  const inspectOnrampOnce = async () => {
    if (!onramp?.afterFirstLoad || onrampInspected) return;
    onrampInspected = true;
    await onramp.afterFirstLoad();
  };

  // Warmup, before the counters and marks: its DOM work must not land in the counts, and its
  // wall must not land in the samples. prepare() already ran, so warmup repeats the flow itself.
  recording = false;
  for (let warm = 0; warm < options.warmup; warm++) {
    await run(driverArg);
    await inspectOnrampOnce();
  }
  recording = true;

  // prepare() and warmup have run; open the CPU sampler HERE, right before the run mark, not before
  // prepare. The V8 sampler is not windowed after the fact (there is no trace clock in the default
  // capture mode to slice it by), so anything it samples lands in the model. Started before prepare it bills
  // prepare's and every warmup's page-side JS to the run: on a probe whose run() does ~5ms and
  // prepare() does ~80ms, JS self-time reads ~88ms with prepare as the top hot function. Starting it
  // after warmup makes the profile's lifetime the run window (the settle tail aside, which is idle),
  // symmetric with bench, where setup already runs before the sampler. The trace counts are windowed
  // from the mark regardless, so the trace may start earlier; only the sampler must not.
  if (beforeRunWindow) await beforeRunWindow();

  // prepare() and warmup have run; mark the run window so setup DOM work stays outside it (the
  // trace counts, when a trace is captured, are windowed start-onward from this mark).
  await mark("wpd:run:start");

  // The loop that turns a single sample into a distribution. run() is called once per iteration
  // and re-measures every step, so a label's samples are its own repetitions.
  //
  // There is deliberately no reset hook: a flow that needs a fresh page per iteration expresses
  // it as a bare page.goto() inside run() outside any measureStep, which is strictly more
  // expressive than a boolean (it makes the fresh/in-place choice per step, not per run) and
  // needs no API at all.
  let partial: PartialRun | undefined;
  for (iteration = 0; iteration < options.iterations; iteration++) {
    usedLabels = new Set<string>();
    indexInIteration = timedIndexBase;
    try {
      await run(driverArg);
    } catch (error) {
      // A flow that never completed a full iteration (iteration 0 failed, or --keep-partial was not
      // set) has nothing honest to salvage: rethrow so a broken flow is a hard error, not a quietly
      // empty recording. When --keep-partial is set and an earlier iteration DID complete, keep those
      // and disclose the failure loudly (record.ts turns `partial` into a note + stderr warning).
      if (!options.keepPartial || iteration === 0) throw error;
      // Discard the failed iteration's partial steps: they are the trailing entries (steps push in
      // order), and a half-measured iteration would fail the same-labels-each-iteration check and
      // skew a label's median with a sample that measured less work than it claims.
      while (steps.length && steps[steps.length - 1].iteration === iteration) steps.pop();
      partial = {
        requested: options.iterations,
        completed: iteration,
        failedIteration: iteration,
        failedStep: activeStepLabel,
        reason: error instanceof Error ? error.message : String(error),
      };
      break;
    }
    // After iteration 0's navigation settled: refuse a bot-wall before more iterations run (a no-op
    // once warmup already inspected). A BotWallError propagates out to abort the record.
    if (iteration === 0) await inspectOnrampOnce();
  }
  await mark("wpd:run:end");

  // Don't run cleanup here; return it so record.ts can call it after tracing stops,
  // keeping teardown work out of the measured window.
  return {
    steps,
    lifecycle,
    ...(partial ? { partial } : {}),
    cleanup: cleanup
      ? () => {
          inCleanup = true;
          return cleanup(driverArg);
        }
      : undefined,
  };
}
