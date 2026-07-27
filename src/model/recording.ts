import type { Measured } from "./measured.js";
import type { NormalizedEvent } from "./events.js";
import type { CpuSlice, CpuJsSlice } from "./cpu.js";
import type { RecordingMeta } from "./meta.js";
import type { FrameSideTrack } from "./frames.js";

// The model is split across focused domain files by domain; this module keeps the
// Recording/RecordingSummary/Span core and RE-EXPORTS the moved types every reader consumes through
// it, so `../model/recording.js` stays the one import path. (WorkloadLane has no consumer through the
// barrel, so it is not re-exported; import it from ./meta.js if one ever needs it.)
export type { EventKind, StackFrame, NormalizedEvent, InvalidationRecord } from "./events.js";
export type {
  CpuFunction,
  CpuGroupStat,
  CpuEdge,
  CpuSystem,
  CpuSlice,
  CpuJsSlice,
  CpuBreakdown,
  CpuModel,
} from "./cpu.js";
export type { FrameState, FrameRecord, FrameSideTrack } from "./frames.js";
export type {
  BlameSemantic,
  DirtiedByWrite,
  ThrashStep,
  ThrashReport,
  DirtiedByWriteRollup,
  FirefoxDirtiedByReport,
} from "./attribution.js";
export type { SourceMapFailure, SourceMapDiagnostics } from "./sourcemap-meta.js";
export type { WorkloadIdentity, RecordingMeta } from "./meta.js";

export interface TimingEntry {
  name: string;
  startTime: number;
  duration?: number;
}

/** Timing is coarse (Chrome clamps performance.now); these are directional, not precise. */
export interface BenchStats {
  samples: number;
  minMs: number;
  medianMs: number;
  meanMs: number;
  maxMs: number;
}

export interface RecordingSummary {
  /** wall time of the run/step window (coarse) */
  wallMs: number | null;
  /** worst interaction-to-next-paint in the window, ms (driver mode); null if unmeasured */
  inpMs: number | null;
  /**
   * In-page CWV split of `inpMs` for the step it came from. Absent on lanes with no observed
   * interaction (bench/node), and null when no step crossed the 16ms Event Timing floor.
   */
  interaction?: InteractionTiming | null;

  /**
   * Rendering counts and durations are `Measured` (model/measured.ts): a number is the exact count
   * (0 = measured clean), null = NOT measured in this capture mode. The default mode (sampler only, no
   * trace) observes no rendering work at all, so every count/duration here is null there, never a
   * fake 0. Counts come from the trace, windowed on the bar's main thread; a `--breakdown`/`--deep`
   * capture supplies them.
   */
  layoutCount: Measured<number>;
  /**
   * Wall-tier trace duration (`base::TimeTicks`, ~1% directional), valid only on the light
   * (no-`.stack`) trace. Null in the default mode (no trace) AND on `--deep`, whose `.stack` trace
   * inflates style dur up to +38% (a distorted number is worse than none). Run `--breakdown` for it.
   */
  layoutMs: Measured<number>;
  styleCount: Measured<number>;
  /** wall-tier trace duration; same not-measured rule as `layoutMs` (light trace only). */
  styleMs: Measured<number>;
  /**
   * Main-thread paint chunks: one per dirtied region, [measured] exactly N+1 for N regions with
   * zero run-to-run variance. Raster (off-main-thread) is deliberately not in here; it counts
   * scheduler behaviour, not the page. See docs/dev/rendering-counts.md. `Measured`: null on the
   * default mode (no trace) and on Firefox (paint is off-main-thread there), never a fake 0.
   */
  paintCount: Measured<number>;
  /** wall-tier trace duration; same not-measured rule as `layoutMs` (light trace only). */
  paintMs: Measured<number>;

  layoutInvalidations: Measured<number>;
  paintInvalidations: Measured<number>;
  styleInvalidations: Measured<number>;

  /**
   * layout/style synchronously forced by JS (thrashing), as a `Measured` value (see
   * model/measured.ts): a number is the count (0 = measured, no thrashing); null = NOT measured,
   * because the mode dropped the `.stack` trace category forced detection needs (--breakdown). The
   * tri-state contract -- incl. why a gate treats null as a loud failure -- lives on the Measured type.
   */
  forcedLayoutCount: Measured<number>;
  forcedLayoutMs: Measured<number>;

  /** tasks >= 50ms ("long tasks") in the window; `Measured`, null in the default mode (no trace). */
  longTaskCount: Measured<number>;
  /** wall-tier trace duration; same not-measured rule as `layoutMs` (light trace only). */
  longestTaskMs: Measured<number>;

  /** JS self-time from the CPU model (`CpuModel.jsSelfMs`); `Measured`, null on `--deep` (sampler off,
   * no CPU model). NOT the non-idle sampled total: gc/engine/native are excluded. */
  jsSelfMs: Measured<number>;
  totalEvents: number;

  /**
   * Per-iteration wall times of the measured unit + their stats. Bench: each timed run() call.
   * A per-step recording: that step's repetitions under --iterations. Empty on the overall
   * recording of a driver run, whose steps are heterogeneous (see perStep).
   */
  perIteration: number[];
  stats: BenchStats | null;
  /**
   * driver (stepped) only: each step's wall timing, labelled. Empty in bench/node runs.
   *
   * Deliberately NOT folded into the `stats` above: steps are heterogeneous ("mount" vs "inp"),
   * so a median across them would be meaningless. Each step carries its own samples + stats
   * instead, which is the only aggregation that means anything here.
   */
  perStep: StepTiming[];
}

/**
 * One driver step's wall timing. Mirrors the bench shape (`perIteration` + `stats`) so a step
 * block reads exactly like the top-level one, and so repeating a step later only lengthens the
 * array rather than changing the type.
 */
export interface StepTiming {
  label: string;
  /**
   * Raw per-iteration wall times for THIS step, in run order; never empty. Raw samples are kept
   * rather than only the aggregate: a median hides bimodality (a GC spike in one iteration), and a
   * consumer may want its own statistic. This array is the axis that grows when a step is repeated,
   * so the shape holds either way.
   */
  perIteration: number[];
  /** this step's own min/median/mean/max; null below 2 samples, same contract as the bench `stats` */
  stats: BenchStats | null;
}

export interface RecordingWindow {
  measure: string;
  /** trace clock microseconds; null if markers not found in trace */
  startTs: number | null;
  endTs: number | null;
  wallMs: number | null;
}

/**
 * An interaction's latency, split the way Core Web Vitals splits INP: a slow interaction is slow
 * because the main thread was busy when the input arrived (input delay), because your handler ran
 * long (processing), or because rendering the result took a while (presentation delay).
 *
 * They sum to the latency of the interaction they describe, but **do not assume they sum to
 * `inpMs`**. Two reasons, both real: `inpMs` is the max duration over EVERY Event Timing entry,
 * including ones outside the interaction, while these come from the worst interaction's own group;
 * and under `--iterations` each part is medianed independently, so three medians are not one
 * interaction (see mergeSteps, which explains why that is still the honest choice).
 *
 * Measured in-page by the Event Timing observer, so unlike a step's `wallMs` these describe the
 * PAGE, not the driver: identical work reports the same processing time whether the step was driven
 * by `page.click` or `page.evaluate`, while its wall differs by ~8ms between the two. They are also
 * finer-grained than `inpMs` itself, which the spec rounds to 8ms: a 45ms handler reads
 * `processingMs` 45.4 inside an `inpMs` of 64.
 *
 * Grouped by `interactionId` per the web-vitals algorithm. Chrome emits the whole pointer sequence
 * (pointerover, mouseover, ...) sharing one duration, but only the interaction's own events carry a
 * non-zero interactionId; picking by duration alone would tie and could read `processing` off
 * `pointerover`, which does nothing (measured: 0.10 vs the click's 45.20).
 */
export interface InteractionTiming {
  /** input arrival -> handler start: the main thread was busy with something else */
  inputDelayMs: number;
  /** the event handlers themselves, first processingStart to last processingEnd */
  processingMs: number;
  /** handler end -> next paint: the cost of rendering the result */
  presentationDelayMs: number;
}

/**
 * One script the browser attributed inside a long animation frame (a `PerformanceScriptTiming`
 * entry). This is where a slow interaction's cost is named at the source: which listener/callback
 * ran, from which script, and how much of its time went to synchronous style/layout it forced.
 *
 * `sourceURL` is the SERVED script url, not rewritten to a local source path: LoAF gives a
 * character offset (`sourceCharPosition`, not stored) rather than a line, so a line-level rewrite
 * would be a guess. Read it as "this script", cross-referenced with the hot-function list for the
 * source line. Chrome-only: no Firefox equivalent ships today, so a firefox recording carries none.
 */
export interface LoafScript {
  /** what invoked the script, e.g. "BUTTON#btn.onclick" or a classic script url */
  invoker: string;
  /** how it was invoked: "event-listener" | "user-callback" | "resolve-promise" | "classic-script" | ... */
  invokerType: string;
  /** the served script url (not a local source path; LoAF gives a char offset, not a line) */
  sourceURL: string;
  /** the function name LoAF attributed, when it carried one (often empty for an inline listener) */
  sourceFunctionName?: string;
  /** ms this script ran inside the frame */
  durationMs: number;
  /** ms of that spent in synchronous (forced) style/layout the script triggered */
  forcedStyleLayoutMs: number;
}

/**
 * One long animation frame (a `long-animation-frame` entry): a frame that ran over the 50ms budget,
 * with the scripts the browser blamed for it.
 */
export interface LoafFrame {
  /** the frame's total duration, ms */
  durationMs: number;
  /** the frame's blocking time over the 50ms budget, ms (LoAF's own `blockingDuration`) */
  blockingDurationMs: number;
  /** the scripts LoAF attributed, worst-first, capped and noise-filtered; may be empty */
  scripts: LoafScript[];
}

/**
 * Long Animation Frames observed in a driver step's window (Chrome only). A LoAF names the scripts
 * that made a frame slow, so it attributes a step's cost to source EVEN in capture modes with no CPU
 * sampler and no trace: the in-page `long-animation-frame` observer is ungated by any capture cap. Chrome
 * ships the API today and Firefox does not, so a firefox/node step carries none (absent, never a
 * fabricated zero). See browser/driver.ts.
 */
export interface StepLoaf {
  /** the observed long animation frames, worst-first, capped */
  frames: LoafFrame[];
  /** total long-animation-frame duration across all observed frames, ms (before the frame cap) */
  totalDurationMs: number;
  /** total blocking time over budget across all observed frames, ms (before the frame cap) */
  totalBlockingMs: number;
  /** how many long animation frames were observed before the frame cap */
  observedFrames: number;
}

/**
 * How a driver step's document changed across its window, decided from two CDP-free reads taken at the
 * step's start and end marks -- `page.url()` and the document's `performance.timeOrigin` (which a full
 * reload resets). See docs/dev/navigation-and-lcp.md.
 *
 *  - "none": the URL did not change and `timeOrigin` held. A same-document step (a click, a render)
 *    and a static step alike.
 *  - "hard": `timeOrigin` moved (> HARD_NAV_ORIGIN_DELTA_MS), so the document reloaded -- a fresh
 *    document, a fresh LCP. The clock outranks URL equality: a reload or a goto to the same URL is
 *    hard with an unchanged URL.
 *  - "soft": the URL changed but `timeOrigin` held byte-identical, an SPA same-document route change.
 *  - "soft-hash": a soft change where the new URL differs ONLY in its fragment (`#...`). Both the
 *    url+timeOrigin rule and Chrome's experimental heuristic count a hash-route overlay as a
 *    navigation, so it earns its own label rather than reading as a route change.
 *
 * A query-only change (`?q=`) stays plain "soft": a URL diff cannot know an in-page filter from a
 * route, and the URLs are stored for the reader to judge. A change-then-revert within one step reads
 * as "none" (a before/after diff cannot see the excursion); a documented blind spot.
 */
export type NavigationKind = "none" | "hard" | "soft" | "soft-hash";

/**
 * One Largest Contentful Paint entry observed during a driver step's boot, serialized in-page from the
 * live `LargestContentfulPaint` entry (its `element` is a node the observer cannot post across the
 * boundary, so the identifiers are read at observe time). Stored ONLY on a step that started a fresh
 * document -- the built-in load step and any HARD-navigation step -- because LCP freezes at the first
 * trusted interaction and never re-fires on a soft navigation, so a per-soft-step LCP is structurally
 * empty. Chrome populates url/size/element; Firefox's fidelity is measured in docs/dev/navigation-and-lcp.md.
 *
 * Wall-tier directional (a paint timestamp on the page's own clock, same trust tier as INP). The
 * identifiers to trust across a production build are `url` + `size` + `tag`; `id` is often absent and
 * `className` is a hashed CSS-module name kept only as a tertiary hint. `renderTimeMs` is the paint
 * time; the spec gates it behind `Timing-Allow-Origin` for a cross-origin resource, but current Chrome
 * populates it for cross-origin images more often than that rule implies. When it is absent (a
 * genuinely TAO-gated resource) the entry reads 0 by spec and `loadTimeMs` is the timing left, so both
 * are surfaced.
 */
export interface StepLcp {
  /**
   * The entry was dropped as an implausible outlier and carries no timing: Chrome's built-in headless
   * intermittently reports a grossly inflated `startTime` (~60s on a page that finished in ~40ms). When
   * set, no other field is present -- a suppressed marker, never a fabricated 60s LCP printed as fact.
   */
  suppressed?: boolean;
  /** the LCP resource url (an image); absent for a text LCP, which has none */
  url?: string;
  /** the entry's `size` (intrinsic area, px^2); absent when 0 */
  size?: number;
  /** the LCP element's tag name (e.g. "IMG", "H1"); the identifier that survives a production build */
  tag?: string;
  /** the element's `id`, when it carried one (often absent on a production build) */
  id?: string;
  /** a truncated `className`, a tertiary hint only (often a hashed CSS-module name); absent when empty */
  className?: string;
  /** render timestamp, ms; populated only same-origin or with Timing-Allow-Origin, else absent (reads 0) */
  renderTimeMs?: number;
  /** resource load timestamp, ms; the timing left when renderTime is unavailable */
  loadTimeMs?: number;
  /** the entry's `startTime`, ms on the document's own clock (the paint time) */
  startTimeMs?: number;
}

/**
 * The seven work slices of a span, plus idle. Every slice is main-thread self-time from the TRACE
 * (children subtracted from parents), so they never overlap; `idle` is the window remainder. The
 * `js` slice alone is subdivided by package, from the CPU samples that landed inside its self-time
 * regions (proportions only -- sampled ms are never added to trace ms). See trace/breakdown.ts.
 */
export interface BreakdownSlices {
  /** scripting self-time, split by owning package (same buckets as packageRollup) */
  js: CpuJsSlice;
  /** style recalc (UpdateLayoutTree/RecalcStyles) */
  style: CpuSlice;
  /** layout (reflow) */
  layout: CpuSlice;
  /**
   * Main-thread paint record. `Measured` (model/measured.ts): a chrome seven-slice bar always
   * measures it; null on firefox, where paint is off-main-thread (a compositor side track, never
   * summed into the wall), so the bar says not-measured rather than a fake 0.
   */
  paint: Measured<CpuSlice>;
  /** garbage collection (MinorGC/MajorGC) */
  gc: CpuSlice;
  /** task remainder + anything unclassified (composite/invalidation/user-timing/other) */
  other: CpuSlice;
  /** the window not covered by any main-thread work; on a paint-terminated span this is vsync wait */
  idle: CpuSlice;
}

/**
 * A reconciling decomposition of one span's trace window: `Σ slices + idle === wallMs` exactly in
 * memory. On disk the numbers are rounded to 4 decimals by serialize, so a persisted slice sum can
 * differ from `wallMs` by up to ~1e-3 ms; that rounding dust is not a `residualMs`.
 *
 * Durations come from the trace (disjoint main-thread self-time), so the sum is exact by
 * construction, not a proportional allocation against an external wall. The one honesty valve is
 * `residualMs`: if the tiling ever fails to close (lost events, clock skew), the gap is carried
 * here rather than rescaling a slice to force the sum. It is absent/0 in the normal case.
 */
export interface Breakdown {
  /** the span's trace window span, ms (endTs - startTs) */
  wallMs: number;
  slices: BreakdownSlices;
  /** wallMs - (Σ slices + idle); present only when the tiling did not close within float dust */
  residualMs?: number;
}

/** A per-span hot-function reference: joins to the sibling `CpuModel.functions[]` by `id` (the run's
 * frame rank by self time), so a reader resolves the name/source/package from the model rather than
 * duplicating them per span (~35B/entry keeps the artifact digest-sized). */
export interface SpanHotRef {
  /** index into the sibling CpuModel.functions[] */
  id: number;
  /** pooled ranked-JS samples attributed to this function in the span's window(s) */
  samples: number;
  /** samples * sampler interval, ms. Informational: the SHARE of `pooledSamples` is the primary unit. */
  selfMs: number;
}

/**
 * Per-span hot functions, top-K by pooled ranked-JS sample count, on the CPU-sampler SCRIPTING axis.
 *
 * This is NOT the bar's `js` slice and never reconciles against it: the two are different axes (the
 * sampler bills a forced layout to the JS frame that forced it, so this list's ms can exceed the
 * bar's `js.ms` many-fold). The invariant is `Σ selfMs <= the span's window wall`, not `<= js.ms`.
 *
 * Stored on --breakdown (chrome) step/measure spans and firefox measure spans. The run span carries
 * none -- its hot list is read from the CpuModel at query time (the sampler brackets the whole loop,
 * so the model IS the run window). Pooling is MEASURE-only: a `measure` label pools samples across
 * all its occurrences (`occurrences` > 1), a step tallies its single iteration-0 window. Below
 * ~10 pooled samples the ranking is suppressed (`suppressed: true`, no `functions`) rather than
 * fabricating a top-N from noise; the reader raises --iterations. Per-function >= 3-sample floor.
 */
export interface SpanHot {
  scope: "step-window" | "measure-pooled";
  /** pooled ranked-JS samples the ranking is built from -- the share denominator */
  pooledSamples: number;
  /** occurrences pooled: N for a repeated measure, 1 for a step or a once-seen measure */
  occurrences: number;
  /** true when `pooledSamples` was below the floor: no `functions`, raise --iterations */
  suppressed?: boolean;
  /** top-K refs by pooled samples (each >= the per-function floor); absent when suppressed */
  functions?: SpanHotRef[];
}

/** Which kind of span a breakdown describes. */
export type SpanKind = "run" | "step" | "measure";

/**
 * How a span's numbers combine the recording's timed iterations. `"sum"`: the window spans every
 * iteration, so the numbers are a TOTAL across them (the run span). `"first"`: the numbers describe
 * ONE iteration -- a step windowed to the first timed iteration (counts never scale with
 * `--iterations`), or a `performance.measure` seen once. `"median"`: a `performance.measure` that
 * recurred, reported as the lower-median-by-wall occurrence (a real reconciling sample, not per-slice
 * averages). The one value both the stored bars (`model/spans.ts` `spanAggregation`) and the span
 * model speak in.
 */
export type SpanAggregation = "first" | "sum" | "median";

/**
 * Exact rendering counts windowed to ONE span's representative occurrence (the run window; a step's
 * first timed iteration). Each field is `Measured` (model/measured.ts): a capture mode that cannot observe a
 * count reports null, never a fake 0 (the default mode has no trace; --breakdown drops the `.stack`
 * category forced detection needs). A forced flush is already inside `layoutCount`/`styleCount`
 * (`forcedLayoutCount` re-reports the JS-triggered SUBSET), so a reader must never sum forced onto
 * layout + style.
 */
export interface SpanCounts {
  layoutCount: Measured<number>;
  styleCount: Measured<number>;
  paintCount: Measured<number>;
  /** the JS-forced SUBSET of `layoutCount`/`styleCount`, never a separate addend */
  forcedLayoutCount: Measured<number>;
  layoutInvalidations: Measured<number>;
  styleInvalidations: Measured<number>;
  /** tasks >= 50ms ("long tasks") within this span's window */
  longTaskCount: Measured<number>;
}

/**
 * Layout/style SCOPE for one forced read-site (chrome --deep): how much the flush(es) at this source
 * line relaid out or recalculated. A COUNT-tier fact, read from the flush event's trace `args` at read
 * time; shown BESIDE the ms, never as a proxy for it (per-object cost ranges ~30x, so the object count
 * does not rank flushes by time). A row that mixes a layout and a style flush at one line carries both
 * fields; layout and style have DIFFERENT denominators and are never merged into one figure.
 */
export interface FlushScope {
  /**
   * render-tree LayoutObjects relaid out by the widest Layout flush at this line, over that flush's
   * `totalObjects` denominator (e.g. `801/2006`). NOT DOM nodes: anonymous boxes split one element
   * into several ([measured] `dirtyObjects` = N+1 LayoutObjects for N dirtied boxes). Absent on a
   * style-only line and on traces predating the scope fields. Chrome only (Gecko Reflow markers carry
   * no scope).
   */
  layoutObjects?: { dirty: number; total: number };
  /**
   * elements recalculated by the widest UpdateLayoutTree flush at this line (`elementCount`, [measured]
   * exact). A different denominator from `layoutObjects`, never merged. Absent on a layout-only line.
   * Chrome; the Gecko analog is `elementsStyled` (compares within an engine only).
   */
  elementsStyled?: number;
  /**
   * a subtree-contained flush at this line (`partialLayout` true): the container root `nodeName` (e.g.
   * "DIALOG"). Absent when every flush was whole-document (the near-constant case on a framework app).
   * Chrome only.
   */
  containedRoot?: string;
}

/** A p50/max distribution over a set of flushes. A DISTRIBUTION, never a sum: a thrash loop re-dirties
 * the same nodes every flush, so summing double-counts them. `flushes` is how many the distribution
 * covers. */
export interface ScopeStats {
  /** median flush size across the window */
  p50: number;
  /** the widest single flush */
  max: number;
  /** flushes this distribution covers */
  flushes: number;
}

/**
 * Per-span layout/style SCOPE distribution across a span window's main-thread flushes (chrome
 * --breakdown; firefox style only). A COUNT-tier fact, computed at record time like the counts and
 * shown BESIDE the reconciling bar's ms, never as a proxy for it. Aggregated as a DISTRIBUTION
 * (p50/max), NEVER a sum. Layout scope and style scope have different denominators and stay separate.
 */
export interface SpanScope {
  /**
   * `dirtyObjects` (render-tree LayoutObjects, not DOM nodes) across the window's Layout flushes.
   * Chrome only -- Gecko Reflow markers carry no scope, so the field stays absent on firefox rather
   * than a fake zero. Absent when the window laid out nothing.
   */
  layoutObjects?: ScopeStats;
  /**
   * `elementCount` (elements recalculated) across the window's UpdateLayoutTree flushes. Chrome, and
   * firefox from the `Styles` markers' `elementsStyled`. Same DEFINITION across engines but a ~2x
   * cross-engine batching gap, so it ranks flushes WITHIN one engine only. Absent when the window
   * recalculated no style.
   */
  elementsStyled?: ScopeStats;
  /**
   * subtree-contained flushes (`partialLayout` true) in the window: how many, and one container root
   * `nodeName` as a sample. `partialLayout` is near-constant whole-document on a framework app, so this
   * is a per-window fact ("this flush was contained"), not a per-span metric. Absent when every flush
   * was whole-document. Chrome only.
   */
  contained?: { flushes: number; sampleRoot?: string };
}

/**
 * The one labelled unit of measured work in a recording -- the run window (`kind: "run"`), a driver
 * step (`"step"`), or a user `performance.measure` (`"measure"`). The run, its steps, and every
 * per-span bar are one `Span[]`.
 *
 * `aggregation` says how the numbers combine the timed iterations (see SpanAggregation). Fields are
 * populated by what the capture mode measured: `breakdown` (the reconciling seven-slice bar) only under
 * --breakdown / firefox / node; `counts` exactly under --breakdown/--deep/firefox and not-measured in
 * the default mode; INP/interaction only on a driver step that observed one. Not-measured is an
 * explicit null, never a fabricated 0.
 */
export interface Span {
  label: string;
  kind: SpanKind;
  /**
   * How this span's numbers combine the timed iterations (see SpanAggregation). A `"first"` STEP span
   * is aggregated PER FIELD, not uniformly: `wallMs` and `inpMs`/`interaction` are the MEDIAN of the
   * step's `--iterations` samples (with `perIteration`/`stats` the raw spread), while `counts` and
   * `breakdown` come from the FIRST timed iteration (counts never scale with --iterations). So a step
   * reports a median latency over iteration-0 counts, disclosed here rather than implied.
   */
  aggregation: SpanAggregation;
  /** a step's position within its iteration; absent on run/measure spans */
  index?: number;
  /**
   * Headline wall (ms) on the page's own clock: the trace-clock window between the span's marks
   * (--breakdown/--deep), else the page's performance.now delta (a driver step in the default mode),
   * else the summed timed samples (a bench run). Null when unmeasured (a step that navigated in a
   * no-trace capture mode; see docs/dev/driver-timing.md).
   */
  wallMs: number | null;
  /**
   * Which clock priced a STEP span's wall: "trace" (the window between its marks; reconciles with
   * the bar) or "page" (the page's performance.now delta; beside a trace-clock `breakdown` it does
   * NOT reconcile with the bar, e.g. a step whose end mark was lost). Absent on run/measure spans,
   * whose clock is fixed by kind (see wallMs), and when wallMs is null.
   */
  wallClock?: "trace" | "page";
  /**
   * The reconciling seven-slice bar (`Σ slices + idle = wallMs`), when the capture mode built one
   * (--breakdown / firefox / node). Absent in the default and --deep capture modes, which report identities
   * and counts but no bar. When `aggregation` is `"median"` this is the lower-median-by-wall
   * occurrence VERBATIM (a real reconciling sample, not per-slice averages).
   */
  breakdown?: Breakdown;
  /** exact rendering counts windowed to this span's representative occurrence; Measured throughout */
  counts: SpanCounts;
  /** worst-interaction INP (ms) for a driver step; null when no interaction crossed the 16ms floor */
  inpMs?: number | null;
  /** in-page CWV split of `inpMs` (a driver step); absent when no interaction was observed */
  interaction?: InteractionTiming | null;
  /**
   * Long Animation Frames observed in a driver step's window, with the scripts the browser blamed
   * (Chrome only; absent on firefox/node steps, run/measure spans, and older recordings). This
   * attributes a step's cost to source even in capture modes the CPU sampler cannot reach (the in-page
   * observer is ungated by any capture cap). See StepLoaf.
   */
  loaf?: StepLoaf;
  /**
   * How this driver step's document changed across its window (none/hard/soft/soft-hash), from the
   * step's own before/after `page.url()` + `timeOrigin` reads (see NavigationKind). Present on a driver
   * step span; absent on run/measure spans and older recordings. A merged step reports iteration 0's
   * classification (iterations replay the same flow). Chrome and Firefox alike (both reads are
   * lane-independent).
   */
  navigation?: NavigationKind;
  /** the URL the step started on (`page.url()` at the start mark); present on a driver step span */
  beforeUrl?: string;
  /** the URL the step ended on (`page.url()` at the end mark). Never assume it is the next step's
   * beforeUrl: a replaceState can fire between steps, so each step's pair is self-contained. */
  afterUrl?: string;
  /**
   * Boot LCP for a step that started a fresh document (the built-in load step, or a HARD-navigation
   * step); absent on soft/none steps, where LCP is structurally frozen (never a fake 0). Wall-tier
   * directional. See StepLcp.
   */
  lcp?: StepLcp;
  /**
   * Per-iteration wall samples in run order (a driver step under --iterations, or a bench run). Raw,
   * not just the aggregate: a median hides the bimodality that says "the first iteration was cold".
   * Absent for a single-sample span.
   */
  perIteration?: number[];
  /** min/median/mean/max over `perIteration`; null below 2 samples */
  stats?: BenchStats | null;
  /**
   * How many real occurrences were merged into `breakdown` (a `measure` label recurring once per
   * --iteration, and/or within one). Absent means a single occurrence -- the run, a step, an
   * unrepeated measure. When present (> 1), `aggregation` is `"median"`.
   */
  samples?: number;
  /** wall (ms) of the shortest merged occurrence; disclosed with `samples` (`wallMinMs <= wallMs <= wallMaxMs`) */
  wallMinMs?: number;
  /** wall (ms) of the longest merged occurrence; disclosed with `samples` */
  wallMaxMs?: number;
  /**
   * Off-thread compositor frame side track for this span (Chrome --breakdown only). DISPLAY-ONLY:
   * never summed into `breakdown`, never gated (its counts are scheduler noise). See FrameSideTrack.
   */
  frames?: FrameSideTrack;
  /**
   * Per-span hot functions on the CPU-sampler scripting axis (--breakdown chrome step/measure, firefox
   * measure). Absent on the run span (read from the CpuModel at query time), in capture modes with no
   * sampler, and on older recordings. Refs join to the sibling CpuModel.functions[]. See SpanHot.
   */
  hot?: SpanHot;
  /**
   * Per-span layout/style scope distribution (chrome --breakdown run/step/measure; firefox style only).
   * A count-tier distribution shown beside the bar's ms, never a proxy for it. Absent in capture modes
   * that store no per-span bar (default/--deep/--precise-wall), on windows with no flush, and on older
   * recordings. See SpanScope.
   */
  scope?: SpanScope;
}

/** One span's seven-slice breakdown, keyed by its label (the run, a driver step, or a user measure). */
export interface SpanBreakdown {
  label: string;
  kind: SpanKind;
  breakdown: Breakdown;
  /**
   * Off-thread compositor frame side track for this span (Chrome --breakdown only; absent
   * otherwise, and on spans whose window caught no frame). DISPLAY-ONLY: never summed into
   * `breakdown`, never gated. See FrameSideTrack.
   */
  frames?: FrameSideTrack;
  /**
   * How many real occurrences of this label were merged into `breakdown` (a `measure` label that
   * recurs once per --iteration and/or within one iteration; see model/span-merge.ts). Absent means a
   * single occurrence -- the run span, a step, or an unrepeated measure -- so old recordings and
   * unrepeated flows carry nothing extra. When present (> 1), `breakdown` is the lower-median-by-wall
   * occurrence VERBATIM (a real reconciling sample, not per-slice averages), and the aggregation is
   * `"median"`.
   */
  samples?: number;
  /** wall (ms) of the shortest merged occurrence; disclosed with `samples`, so a reader sees the spread. */
  wallMinMs?: number;
  /** wall (ms) of the longest merged occurrence; disclosed with `samples`. */
  wallMaxMs?: number;
  /**
   * Per-span hot functions on the CPU-sampler scripting axis (--breakdown chrome step/measure, firefox
   * measure); absent on the run span and in capture modes with no sampler. Copied onto the stored `Span.hot`. See
   * SpanHot. When a measure merged occurrences, this is POOLED across all of them (not the kept bar's
   * single occurrence), so the list has a firmer sample footing than the bar's lower-median sample.
   */
  hot?: SpanHot;
  /**
   * Per-span layout/style scope distribution (chrome --breakdown; firefox style only), copied onto the
   * stored `Span.scope`. When a measure merged occurrences this is the KEPT occurrence's window
   * verbatim (like the bar and frames), not pooled. Absent on a window with no flush. See SpanScope.
   */
  scope?: SpanScope;
}

/**
 * The one small default artifact a run writes (schema 3): the run summary, the collapsed `Span[]`
 * (run + steps + user measures), and meta. The raw `.cpuprofile` and the resolved `.cpu.json` model
 * are separate siblings; the `events[]` DEEP EVENT LOG is written into this file ONLY under --deep
 * (chrome) and firefox, where blame/`query get`/`query events` read it -- every other capture mode leaves it
 * empty, which keeps the default artifact digest-sized.
 */
export interface Recording {
  meta: RecordingMeta;
  window: RecordingWindow;
  marks: TimingEntry[];
  /**
   * The deep event log: resolved trace events with `.stack` frames and invalidation records. Present
   * only in a capture mode that captured one (--deep, firefox); an EMPTY array in the default/--breakdown/
   * --precise-wall capture modes, where `query events`/`get`/`blame` report "not captured in this capture mode".
   */
  events: NormalizedEvent[];
  summary: RecordingSummary;
  /**
   * Every labelled unit of measured work: the run window, each driver step, and every user
   * `performance.measure`. Always present (at least the run span). The one artifact carries them all;
   * steps are spans of `kind: "step"`, read as an anatomy by `query span <label>`.
   */
  spans: Span[];
}

/**
 * One step of a stepped (driver) run, projected from its `kind: "step"` span. Feeds the per-step
 * `assert` targets and the `query span <step-label>` anatomy; carries no per-step file pointers,
 * since the whole run is one recording.
 */
export interface StepIndexEntry {
  index: number;
  label: string;
  /** median of this step's samples under --iterations; the single sample when there is one */
  wallMs: number | null;
  inpMs: number | null;
  /** in-page CWV split of inpMs: where the interaction's latency actually went */
  interaction?: InteractionTiming | null;
  /** this step's own min/median/mean/max; null below 2 samples, same contract as elsewhere */
  stats?: BenchStats | null;
  headline: {
    /** Measured (see model/measured.ts): null when the capture mode captured no trace to count from */
    layoutCount: Measured<number>;
    /** Measured (see model/measured.ts): null when forced detection was not run for this step */
    forcedLayoutCount: Measured<number>;
    paintCount: Measured<number>;
    layoutInvalidations: Measured<number>;
    styleInvalidations: Measured<number>;
    longTaskCount: Measured<number>;
  };
}
