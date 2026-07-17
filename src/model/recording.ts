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
  /** JS stack that triggered this event (top frame first), if Chrome captured one */
  stack?: StackFrame[];
  /** convenience: top meaningful frame as "source:line:col" */
  at?: string;
  /** layout/style synchronously forced by JS (layout thrashing) */
  forced?: boolean;
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

export interface MetricsBlock {
  before: Record<string, number>;
  after: Record<string, number>;
  delta: Record<string, number>;
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

  layoutCount: number;
  layoutMs: number;
  styleCount: number;
  styleMs: number;
  /**
   * Main-thread paint chunks: one per dirtied region, [measured] exactly N+1 for N regions with
   * zero run-to-run variance. Raster (off-main-thread) is deliberately not in here; it counts
   * scheduler behaviour, not the page. See docs/dev/rendering-counts.md.
   */
  paintCount: number;
  paintMs: number;

  layoutInvalidations: number;
  paintInvalidations: number;
  styleInvalidations: number;

  /**
   * layout/style synchronously forced by JS (thrashing). null = NOT measured on this run, which is
   * a different fact than 0 (no thrashing): forced detection needs the `.stack` trace category, so
   * a mode that drops it (--breakdown) reports null and points at the default two-pass mode. A gate
   * like `assert --max-forced` treats null as a loud failure, never a silent pass.
   */
  forcedLayoutCount: number | null;
  forcedLayoutMs: number | null;

  /** tasks >= 50ms ("long tasks") in the window */
  longTaskCount: number;
  longestTaskMs: number;

  scriptingMs: number;
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

export interface ScreenshotRefs {
  before?: string;
  after?: string;
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
 * What a forced-layout blame line names, which is NOT the same question in both engines:
 *
 * - "flush-site" (Chrome/Blink): the geometry READ that forced the pending layout to flush
 *   synchronously, e.g. the `offsetHeight` access. Blink captures the stack at the flush.
 * - "invalidation-site" (Firefox/Gecko): the WRITE that dirtied the DOM and made a flush
 *   necessary, e.g. the style assignment. Gecko captures the stack at invalidation, and only
 *   for the first invalidator since the last flush.
 *
 * Both are real, and neither is a worse answer; they are answers to different questions. Measured
 * on the same probe the two name ZERO lines in common, so diffing a Chrome blame list against a
 * Firefox one compares nothing. Compare each engine against itself, and use `query cpu` (self-time)
 * for the cross-engine view. See docs/dev/engine-mapping.md.
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
  /** measurement passes run in isolation, e.g. ["timing","trace"] (>1 => isolated) */
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
   * Which code this run's forced-layout blame names. The two engines answer different questions,
   * so this is what a cross-engine consumer needs to refuse the comparison rather than make it
   * wrongly. Absent => the run produced no blame (--target node, or Chrome with --no-trace).
   */
  blameSemantic?: BlameSemantic;
  /** execution runtime: "chrome" (Puppeteer page) or "node" (in-process V8, CPU only) */
  runtime?: "chrome" | "node";
  /** artificial slowdown applied during the run */
  throttle?: { cpuRate?: number; network?: string };
  /** when this recording is one step of a stepped run */
  step?: { index: number; label: string };
  screenshots?: ScreenshotRefs;
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
  /** main-thread paint record */
  paint: CpuSlice;
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

/** One span's seven-slice breakdown, keyed by its label (the run, a driver step, or a user measure). */
export interface SpanBreakdown {
  label: string;
  kind: SpanKind;
  breakdown: Breakdown;
}

export interface Recording {
  meta: RecordingMeta;
  window: RecordingWindow;
  marks: TimingEntry[];
  metrics: MetricsBlock;
  events: NormalizedEvent[];
  summary: RecordingSummary;
  /**
   * Per-span seven-slice time breakdowns (--breakdown mode only). Absent otherwise, so existing
   * recordings are unchanged and every reader that predates the field keeps working. Additive: no
   * schema major bump.
   */
  breakdowns?: SpanBreakdown[];
}

/**
 * Small, context-friendly entry point into a (possibly huge) recording. Read this
 * first, then drill by event `id` (`query get`) or bounded `query` calls.
 */
export interface Digest {
  recording: string;
  meta: RecordingMeta;
  window: RecordingWindow;
  summary: RecordingSummary;
  slowestEvents: { id: number; kind: EventKind; name: string; durMs: number; at?: string }[];
  topBlame: { at: string; count: number; durMs: number; kinds: EventKind[] }[];
  /** forced (synchronous) layout/style grouped by source; prime optimization targets */
  forced: { at: string; count: number; durMs: number }[];
  /** longest tasks (>= threshold) as drill-in entry points */
  longTasks: { id: number; ts: number; durMs: number; dominantKind?: string; at?: string }[];
  invalidationsByReason: { kind: string; reason: string; count: number; sampleAt?: string }[];
  /** per-span seven-slice time breakdowns (--breakdown mode only); absent otherwise */
  breakdowns?: SpanBreakdown[];
  hints: string[];
}

/** Entry-point file for a stepped (driver) run; points at per-step files. */
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
    layoutCount: number;
    /** null when forced detection was not run for this step (see RecordingSummary.forcedLayoutCount) */
    forcedLayoutCount: number | null;
    paintCount: number;
    layoutInvalidations: number;
    styleInvalidations: number;
    longTaskCount: number;
  };
  recording: string;
  digest: string;
}

export interface StepIndex {
  meta: RecordingMeta;
  recording: string;
  steps: StepIndexEntry[];
  hints: string[];
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
 * Absent on lanes whose profile does not honestly represent idle (Firefox/Gecko): a fabricated
 * idle is worse than none. Optional, so an older `.cpu.json` without it keeps working everywhere.
 */
export interface CpuBreakdown {
  /** sum of the profile's time deltas, ms; equals CpuModel.totalMs */
  wallMs: number;
  slices: {
    js: CpuJsSlice;
    /** (program)/(root) + tool harness frames; engine/runtime work, unsplit */
    browser: CpuSlice;
    gc: CpuSlice;
    idle: CpuSlice;
  };
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
   * Reconciling `js · browser · gc · idle` decomposition of the sampled window (they tile it
   * exactly). Absent on lanes whose profile does not honestly represent idle (Firefox), and on
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
