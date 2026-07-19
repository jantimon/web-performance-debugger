import type { Measured } from "./measured.js";

export type EventKind =
  | "layout"
  | "style"
  | "paint"
  | "composite"
  | "invalidation"
  | "scripting"
  | "gc"
  | "task"
  | "usertiming"
  | "other";

export interface StackFrame {
  functionName?: string;
  /** original (served) url from the trace */
  url?: string;
  /** url rewritten to a local file path when it came from the local module server */
  source?: string;
  line?: number;
  column?: number;
  /** when source was a bundle with a sourcemap, the pre-map "file:line:col" */
  bundled?: string;
  /** the url is a remote (http) script; its sourcemap is fetched over the network */
  remote?: boolean;
  /** original identifier from the sourcemap's `names`, when it differs from the minified one */
  originalName?: string;
}

export interface NormalizedEvent {
  id: number;
  name: string;
  /** trace clock, microseconds */
  ts: number;
  /** microseconds (0 for instant events) */
  dur: number;
  ph: string;
  kind: EventKind;
  /**
   * Trace process/thread the event ran on. Populated ONLY in --breakdown mode (parseTrace keeps
   * them when asked): the seven-slice engine tiles the renderer main thread alone, so it must tell
   * main-thread work from raster/compositor threads. Every other mode leaves these fields absent.
   */
  pid?: number;
  tid?: number;
  /**
   * The trace async-slice id (`id2.local`/`id2.global`/`id`) for a b/e async event. Populated ONLY
   * in --breakdown mode (parseTrace keeps it alongside pid/tid), so the frame side track can pair
   * each `PipelineReporter` begin/end into a frame; absent in every other mode, which keeps their
   * stored events byte-for-byte.
   */
  asyncId?: string;
  /** JS stack that triggered this event (top frame first), if Chrome captured one */
  stack?: StackFrame[];
  /** convenience: top meaningful frame as "source:line:col" */
  at?: string;
  /** layout/style synchronously forced by JS (layout thrashing) */
  forced?: boolean;
  /**
   * A sampled blame annotation, not a measured event (Firefox read-site forced blame). It carries a
   * source line + property for `query blame --forced` but is NOT a countable flush, so the summary
   * skips it: the counts come from the Gecko Reflow/Styles markers, one per real flush. Absent on
   * every trace-derived event.
   */
  sampled?: boolean;
  /**
   * The WRITE that dirtied this flush, resolved from a Firefox Gecko cause stack (the innermost JS
   * caller of the FIRST invalidation since the last flush). Set on a forced Reflow/Styles marker
   * event under `--deep --target firefox`; absent everywhere else. It is a WRITE, deliberately never
   * surfaced as `at` (which stays the blame read-site), so write and read never collide. Being
   * first-invalidation-only it is Gecko's write, NOT chrome's full write set, and drives no thrash
   * detector. See trace/firefox-dirtied.ts.
   */
  dirtiedBy?: DirtiedByWrite;
  args?: unknown;
}

export interface InvalidationRecord {
  kind: "layout" | "paint" | "style" | "other";
  name: string;
  ts: number;
  reason?: string;
  nodeName?: string;
  at?: string;
}

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
   * (0 = measured clean), null = NOT measured on this rung. The default rung (sampler only, no
   * trace) observes no rendering work at all, so every count/duration here is null there, never a
   * fake 0. Counts come from the trace, windowed on the bar's main thread; a `--breakdown`/`--deep`
   * capture supplies them.
   */
  layoutCount: Measured<number>;
  /**
   * Wall-tier trace duration (`base::TimeTicks`, ~1% directional), valid only on the light
   * (no-`.stack`) trace. Null on the default rung (no trace) AND on `--deep`, whose `.stack` trace
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
   * default rung (no trace) and on Firefox (paint is off-main-thread there), never a fake 0.
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

  /** tasks >= 50ms ("long tasks") in the window; `Measured`, null on the default rung (no trace). */
  longTaskCount: Measured<number>;
  /** wall-tier trace duration; same not-measured rule as `layoutMs` (light trace only). */
  longestTaskMs: Measured<number>;

  /** JS self-time from the CPU model; `Measured`, null on `--deep` (sampler off, no CPU model). */
  scriptingMs: Measured<number>;
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

/** Why a script's sourcemap could not be applied. */
export type SourceMapFailure =
  | /** the script carries neither a sourceMappingURL comment nor a SourceMap header */ "no-sourcemap-url"
  | /** the script itself could not be fetched/read */ "script-fetch-failed"
  | /** the script named a map, but it could not be fetched/read */ "map-fetch-failed"
  | /** the map was fetched but is not valid JSON/not a sourcemap */ "map-parse-failed";

/**
 * What happened to every script a run tried to map. Failure is otherwise invisible: frames keep
 * their minified names and bundle path, so per-package CPU numbers look plausible while
 * attributing everything to the bundle.
 */
export interface SourceMapDiagnostics {
  /** scripts a map was attempted for */
  scripts: number;
  /** of those, how many resolved */
  resolved: number;
  /**
   * Of the ones that did NOT resolve, how many look like build output (a minified body).
   *
   * This is the honest trigger for "the package rollup below cannot be believed", and it is a
   * different question from `resolved === 0`. Plain unbundled source has no sourcemap because it
   * needs none: its frames already carry real names and real lines. A minified bundle with no map
   * is the opposite -- every frame keeps its mangled name and its cost rolls up under whatever
   * package.json sits above the bundle, which reads as a real package. 0 here means a missing map
   * cost you nothing. Optional: an older recording may not carry it.
   */
  unmappedBundles?: number;
  /**
   * failing script urls grouped by reason. Capped per reason (a page can carry hundreds of
   * unmapped third-party scripts), so `scripts`/`resolved` are the authoritative totals.
   */
  failed?: Partial<Record<SourceMapFailure, string[]>>;
  /**
   * Per script whose map RESOLVED but had no mapping for some frame lookups: how many lookups the
   * map answered (`hits`) vs silently dropped (`misses`). Counts are per-lookup, not per distinct
   * position -- the shared resolver queries each frame once per pass (attachStacks x2 +
   * buildCpuModel), so one leaking position lands here once per pass it appears in; the miss share
   * stays honest either way. A miss keeps the frame's minified/remote identity and buckets it by
   * origin, so a map that LOADS fine can still leak attribution -- a different failure from the
   * load-failure reasons in `failed`, and invisible to `resolved` (which counts this script a
   * success). Only scripts with a nonzero miss appear, sorted by miss count and capped, so
   * `scripts`/`resolved` stay authoritative. Optional: an older recording may not carry it.
   */
  positionMisses?: Record<string, { misses: number; hits: number }>;
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
 * What a forced-layout blame line names:
 *
 * - "flush-site": the geometry READ that forced the pending layout to flush synchronously, e.g.
 *   the `offsetHeight` access, with the DOM property named. Produced on BOTH engines: Chrome/Blink
 *   captures the stack at the flush (from the trace's `.stack` category), Firefox/Gecko samples it
 *   from the DOM-accessor label frames on the stack. Comparable across engines at line granularity
 *   (measured: 12/21 lines exact on the shared probe), with a one-statement line-lag caveat where a
 *   sampled read lands on the adjacent statement.
 * - "invalidation-site": the WRITE that dirtied the DOM and made a flush necessary, e.g. the style
 *   assignment. The legacy Firefox semantic (Gecko cause stacks, first invalidator since the last
 *   flush), present only on older recordings.
 *
 * See docs/dev/engine-mapping.md.
 */
export type BlameSemantic = "flush-site" | "invalidation-site";

export interface RecordingMeta {
  tool: string;
  /** the package version that wrote this artifact (e.g. "0.1.0") */
  version: string;
  /** on-disk schema epoch (major-only); see SCHEMA_VERSION. Makes artifacts self-describing. */
  schemaVersion: string;
  createdAt: string;
  mode: "module" | "html" | "url";
  target: string;
  fn: string;
  iterations: number;
  warmup: number;
  headless: boolean;
  /** persistent Chrome profile reused across passes/runs (shorter of relative|absolute), or null */
  userDataDir: string | null;
  /** lifecycle hooks found and called */
  lifecycle: string[];
  /**
   * The one capture that ran, by rung name: "default" (sampler only) | "breakdown" | "deep" |
   * "precise-wall" | "gecko" (firefox) | "node-cpu". Every invocation is exactly one pass (one
   * browser launch, one run of the flow), so this is a single-element array naming the rung, not a
   * multi-pass plan.
   */
  passes: string[];
  notes: string[];
  /**
   * Sourcemap resolution for this run: how many scripts a map was attempted for, how many
   * resolved, and why the rest did not. Absent on runs that attempted none, and on older
   * recordings. When resolution fails, CPU self-time is attributed to
   * minified bundle names rather than the originating package, so this is the field that says
   * whether `query cpu --by package` can be trusted.
   */
  sourcemaps?: SourceMapDiagnostics;
  /** driver (puppeteer) mode: run executed in Node with { page, ctx, measureStep } */
  driver: boolean;
  /** browser backend: "chrome" (default, CDP) or "firefox" (BiDi + Gecko profiler). Absent => chrome. */
  browser?: "chrome" | "firefox";
  /**
   * Which code this run's forced-layout blame names (see BlameSemantic). "flush-site" (the read) on
   * both engines today, comparable at line granularity; "invalidation-site" (the write) only on
   * older Firefox recordings. Absent => the run produced no blame (--target node, or a chrome
   * rung without a .stack trace).
   */
  blameSemantic?: BlameSemantic;
  /** execution runtime: "chrome" (Puppeteer page) or "node" (in-process V8, CPU only) */
  runtime?: "chrome" | "node";
  /** artificial slowdown applied during the run */
  throttle?: { cpuRate?: number };
  /** when this recording is one step of a stepped run */
  step?: { index: number; label: string };
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

/** Terminal verdict of a compositor frame, from PipelineReporter's `frame_reporter.state`. */
export type FrameState = "presented" | "presentedPartial" | "dropped" | "noUpdate";

/**
 * One compositor frame from Chrome's off-thread frame pipeline (a `PipelineReporter` async slice).
 *
 * DISPLAY-ONLY. These are scheduler/settle noise on unchanged code (compositor warmth + how many
 * vsync ticks the settle window happens to span), and 20 recolored boxes present as the same frame
 * count as 1 box, so a frame count does not even track paint work. Only main-thread `Paint` is exact
 * enough to gate. See docs/dev/rendering-counts.md.
 */
export interface FrameRecord {
  /** compositor `frame_sequence`: the frame's identity within the run */
  sequence: number;
  state: FrameState;
  /** the frame was on the smoothness-critical path (a dropped/late one is visible jank) */
  affectsSmoothness: boolean;
  /** frame-pipeline duration (begin-impl-frame -> presentation), ms */
  durMs: number;
}

/**
 * The per-span off-thread frame side track (Chrome --breakdown only). Tallies `PipelineReporter`
 * verdicts, and for the slowest presented (incl. partial) frame carries its top pipeline-stage
 * durations.
 *
 * DISPLAY-ONLY, and the type is shaped so the rule is enforced by construction: this lives on
 * SpanBreakdown, NEVER on RecordingSummary, so the gate readers (`assert`/`diff`, which see only the
 * summary) structurally cannot reach it. Nothing here is summed into any breakdown bar either -- the
 * wall is main-thread self-time and these frames run on compositor/viz threads (the §9 rule). The
 * counts are scheduler noise, the one reason they must not gate; see FrameRecord and
 * docs/dev/rendering-counts.md.
 */
export interface FrameSideTrack {
  presented: number;
  presentedPartial: number;
  dropped: number;
  noUpdate: number;
  /** every frame in the span's window (presented + partial + dropped + noUpdate) */
  total: number;
  /** top pipeline-stage durations of the slowest presented (incl. partial) frame; absent when none presented */
  worstStages?: { name: string; ms: number }[];
  /** raw per-frame records (few per span), for JSON drill-in */
  frames: FrameRecord[];
}

/**
 * Exact rendering counts windowed to ONE span's representative occurrence (the run window; a step's
 * first timed iteration). Each field is `Measured` (model/measured.ts): a rung that cannot observe a
 * count reports null, never a fake 0 (the default rung has no trace; --breakdown drops the `.stack`
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
 * The one labelled unit of measured work in a recording -- the run window (`kind: "run"`), a driver
 * step (`"step"`), or a user `performance.measure` (`"measure"`). Everything the recording used to
 * model as separate artifacts (the run, the step index, the per-span bars) is one `Span[]`.
 *
 * `aggregation` says how the numbers combine the timed iterations (see SpanAggregation). Fields are
 * populated by what the rung measured: `breakdown` (the reconciling seven-slice bar) only under
 * --breakdown / firefox / node; `counts` exactly under --breakdown/--deep/firefox and not-measured on
 * the default rung; INP/interaction only on a driver step that observed one. Not-measured is an
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
   * (--breakdown/--deep), else the page's performance.now delta (a driver step on the default rung),
   * else the summed timed samples (a bench run). Null when unmeasured (a step that navigated on a
   * no-trace rung; see docs/dev/driver-timing.md).
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
   * The reconciling seven-slice bar (`Σ slices + idle = wallMs`), when the rung built one
   * (--breakdown / firefox / node). Absent on the default and --deep rungs, which report identities
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
}

/**
 * The one small default artifact a run writes (schema 3): the run summary, the collapsed `Span[]`
 * (run + steps + user measures), and meta. The raw `.cpuprofile` and the resolved `.cpu.json` model
 * are separate siblings; the `events[]` DEEP EVENT LOG is written into this file ONLY under --deep
 * (chrome) and firefox, where blame/`query get`/`query events` read it -- every other rung leaves it
 * empty, which keeps the default artifact digest-sized.
 */
export interface Recording {
  meta: RecordingMeta;
  window: RecordingWindow;
  marks: TimingEntry[];
  /**
   * The deep event log: resolved trace events with `.stack` frames and invalidation records. Present
   * only on a rung that captured one (--deep, firefox); an EMPTY array on the default/--breakdown/
   * --precise-wall rungs, where `query events`/`get`/`blame` report "not captured at this rung".
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
 * The WRITE end of a forced flush: a DOM mutation that dirtied layout/style so a later geometry read
 * had to flush it synchronously. `at` is the mutation's source line.
 *
 * Both browser lanes reach it, by different routes (docs/dev/engine-mapping.md):
 *  - Chrome `--deep`: from the STYLE-kind invalidation records the trace's invalidationTracking
 *    carries, with the invalidation `reason` (e.g. "Inline CSS style declaration was mutated"). The
 *    layout-kind `LayoutInvalidationTracking` stack names the forcing READ on style-driven
 *    invalidations, not the write, so it is never a dirtied-by (measured). This is the FULL write set
 *    in a flush's gap, which is what lets the thrash detector run.
 *  - Firefox `--deep`: from a Gecko Reflow/Styles marker's cause stack (its innermost JS caller),
 *    with no `reason`. Gecko records only the FIRST invalidation since the last flush, so this is one
 *    write per flush, NOT the full set -- comparable at line granularity but never a thrash input.
 */
export interface DirtiedByWrite {
  /** source line of the mutation (the write), relative to root */
  at: string;
  /** the Chrome invalidation reason string, when the record carried one (absent on firefox) */
  reason?: string;
}

/**
 * One step of the layout-thrashing interleave: a forced flush that re-read geometry an intervening
 * write had re-dirtied since the previous flush in the same task. `read` is the geometry read that
 * paid (the flush-site), `dirtiedBy` the mutation(s) that caused the re-dirty (the write end). A
 * layout-flush step can carry an empty `dirtiedBy`: it is a thrash step because a layout-kind write
 * sat in its gap, but that write's stack names the read, not a surfaceable write (see DirtiedByWrite).
 */
export interface ThrashStep {
  kind: "layout" | "style";
  read?: string;
  dirtiedBy: DirtiedByWrite[];
}

/**
 * The layout-thrashing detector's rollup over a window (Chrome `--deep` only). `count` is Σ thrash
 * steps -- forced flushes re-dirtied since the previous flush in the same top-level task, matched by
 * kind (a layout flush needs a layout write in its gap, a style flush a style write). `steps` is the
 * write->read interleave, capped for size; `omitted` counts thrash steps past the cap. Absent, never
 * a fabricated `count: 0`, on any lane that cannot observe it (the default/--breakdown rungs drop the
 * invalidation records, Firefox has none).
 */
export interface ThrashReport {
  count: number;
  steps: ThrashStep[];
  omitted: number;
}

/** One write line Gecko blamed (firefox `--deep`), rolled up across the forced flushes that named it. */
export interface DirtiedByWriteRollup {
  /** source line of the write (the cause stack's innermost JS caller), relative to root */
  at: string;
  /** which flush kinds this write dirtied (layout, style, or both) */
  kinds: ("layout" | "style")[];
  /** how many forced flushes named this write as their first-since-last-flush invalidation */
  count: number;
}

/**
 * The firefox `--deep` dirtied-by report: Gecko's native cause-stack write identity as a first-class
 * rollup. `semantic: "first-invalidation"` marks the honest scope -- Gecko records only the FIRST
 * invalidation since the last flush, so `writes` is the write Gecko blames, NOT chrome's full write
 * set. This is why the firefox lane runs no thrash detector and fabricates no forced-by read side
 * (the read stays the sampled read-site blame on the same gecko pass). See trace/firefox-dirtied.ts.
 */
export interface FirefoxDirtiedByReport {
  semantic: "first-invalidation";
  writes: DirtiedByWriteRollup[];
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
    /** Measured (see model/measured.ts): null when the rung captured no trace to count from */
    layoutCount: Measured<number>;
    /** Measured (see model/measured.ts): null when forced detection was not run for this step */
    forcedLayoutCount: Measured<number>;
    paintCount: Measured<number>;
    layoutInvalidations: Measured<number>;
    styleInvalidations: Measured<number>;
    longTaskCount: Measured<number>;
  };
}

/** One function aggregated across a CPU sampling profile (self/total time). */
export interface CpuFunction {
  /** stable id = rank by self time; used by `query frame <id>` */
  id: number;
  fn: string;
  /** resolved original "file:line" when a sourcemap was available */
  source?: string;
  /** bare resolved file path (no line), for the by-file rollup */
  file?: string;
  /**
   * Owning npm/workspace package, e.g. "react-dom", "next-yak", "app". Parenthesized buckets are
   * not real packages: "(native)"/"(node)"/"(blob)"/"(inline)"/"(wasm)", and "(<host>)" for a
   * remote script whose sourcemap did not resolve (its owner is genuinely unknown; see
   * RecordingMeta.sourcemaps). "app" means code that IS the profiled app: a resolved source
   * outside node_modules.
   */
  package: string;
  /** the minified V8 name, when `fn` is the sourcemap-resolved original (else absent) */
  minified?: string;
  selfMs: number;
  selfPct: number;
  totalMs: number;
}

/** Self time grouped by some key (package or file). */
export interface CpuGroupStat {
  key: string;
  selfMs: number;
  selfPct: number;
  functions: number;
}

/** A call-graph edge: time the callee's subtree spent directly under the caller. */
export interface CpuEdge {
  caller: number;
  callee: number;
  ms: number;
}

/** Sampled time outside user JS: idle (no JS on stack), GC, and V8 program/runtime. */
export interface CpuSystem {
  idleMs: number;
  gcMs: number;
  programMs: number;
}

/** One slice of the CPU-time breakdown. */
export interface CpuSlice {
  ms: number;
}

/** The `js` slice, subdivided by owning package (same buckets as packageRollup). */
export interface CpuJsSlice extends CpuSlice {
  /** self ms per owning package; sums to `ms` */
  byPackage: Record<string, number>;
}

/**
 * A reconciling decomposition of the CPU profile's own sampled window into where time went.
 *
 * Built from the raw profile's `samples[]` + `timeDeltas[]`: every time delta is attributed to its
 * sample's node, and each node classifies into exactly one slice, so
 * `js + browser + gc + idle === wallMs` EXACTLY in memory, with zero residual. On disk the numbers
 * are rounded to 4 decimals by serialize, so a persisted slice sum can differ from `wallMs` by up to
 * ~1e-3 ms; that rounding dust is not a residual. `wallMs` is the sum of the profile's own time
 * deltas (not an external wall), which is also `CpuModel.totalMs`. That exact tiling is the product
 * promise; it is not a proportional allocation.
 *
 * Honesty constraints, both from docs/dev:
 *  - On browser lanes the `js` slice is NOT pure JS: synchronous engine work JS triggered (a forced
 *    layout) is billed to the forcing frame (~85% of the layout probe's "JS" self-time is reflow).
 *    Only `--target node` measures pure JS. The report annotates this on browser lanes.
 *  - `browser` is engine/runtime work with the profiled JS not on the stack ((program)/(root) plus
 *    the tool's own harness frames), left UNSPLIT: no invented style/layout/paint numbers, which
 *    would require fusing the trace onto this timeline.
 *
 * On chrome/node this carries `js · browser · gc · idle`, all from V8's synthetic frames. On
 * Firefox (js,cpu) it additionally splits `style` and `layout` out of the engine work, from the
 * per-sample Layout-category frame, and idle is the per-sample CPU-usage signal (`threadCPUDelta`),
 * not a category. Absent on a Firefox dump with no CPU signal (a fabricated idle is worse than
 * none) and on older `.cpu.json` files. Optional throughout, so a reader that predates the field or
 * the style/layout slices keeps working.
 */
export interface CpuBreakdown {
  /** sum of the profile's time deltas, ms; equals CpuModel.totalMs */
  wallMs: number;
  slices: {
    js: CpuJsSlice;
    /** style recalc (Firefox: Layout-category style frames). Absent on chrome/node. */
    style?: CpuSlice;
    /** layout/reflow (Firefox: Layout-category reflow frames). Absent on chrome/node. */
    layout?: CpuSlice;
    /**
     * (program)/(root) + tool harness frames on chrome/node; on Firefox also DOM-accessor time and
     * Profiler self-overhead. Engine/runtime work with the profiled JS not on the stack, unsplit.
     */
    browser: CpuSlice;
    gc: CpuSlice;
    idle: CpuSlice;
  };
  /** wallMs - Σ slices; present only when a node's owner resolved to null so its time landed in no
   * slice (the tiling did not close within float dust). Absent/0 in the normal case. */
  residualMs?: number;
}

/**
 * Resolved, self-contained model of a CPU sampling profile. Sized by function count
 * (not sample count), already sourcemap-resolved, so `query cpu` / `query frame` /
 * `cpu-diff` read it post-hoc without the ephemeral capture server. The raw
 * `.cpuprofile` is written alongside for humans (DevTools / Speedscope).
 */
export interface CpuModel {
  /** path to the raw .cpuprofile */
  profile: string;
  meta: RecordingMeta;
  sampleCount: number;
  sampleIntervalUs: number;
  /** wall span of the sampled window, ms */
  totalMs: number;
  /** sampled time excluding idle, ms */
  scriptingMs: number;
  system: CpuSystem;
  /**
   * Reconciling decomposition of the sampled window (the slices tile it exactly): `js · browser ·
   * gc · idle` on chrome/node, `js · style · layout · browser · gc · idle` on Firefox (js,cpu).
   * Absent on a Firefox dump with no `threadCPUDelta` signal (idle would be fabricated) and on
   * older models. Additive: readers that predate it are unaffected.
   */
  breakdown?: CpuBreakdown;
  /** functions sorted by self time descending; id is the index */
  functions: CpuFunction[];
  /** caller->callee edges (thresholded), for callers/callees drilling */
  edges: CpuEdge[];
  /**
   * How many distinct frames could not be attributed to an owner and fell back to an origin
   * bucket (`(cdn.example.com)`). This is what a failed sourcemap actually costs you, and the
   * only honest trigger for "the package rollup cannot be believed". 0 means every frame found
   * its owner -- including when no sourcemap resolved at all, which is the normal case for plain
   * unbundled source that needs no map. Optional: an older model may not carry it.
   */
  unmappedFrames?: number;
}
