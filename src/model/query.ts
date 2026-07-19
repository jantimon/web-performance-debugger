// Shapes emitted by the `query`/`cpu-diff` verbs under `--format json|toon`. These are
// derived views over the on-disk artifacts (model/recording.ts), kept here so the command
// call sites can be annotated and the JSON contract cannot silently drift.

import type {
  CpuBreakdown,
  CpuFunction,
  CpuGroupStat,
  CpuJsSlice,
  CpuSlice,
  CpuSystem,
  DirtiedByWrite,
  EventKind,
  FirefoxDirtiedByReport,
  FrameSideTrack,
  InteractionTiming,
  SpanAggregation,
  SpanCounts,
  SpanKind,
  ThrashReport,
} from "./recording.js";
import type { Measured } from "./measured.js";

/** Functions below the `--top` cutoff in a CPU overview, rolled up. */
export interface CpuDropped {
  frames: number;
  selfMs: number;
}

/** `query cpu` output: scriptingMs headline, by-package/by-file rollups, and the hot list. */
export interface CpuOverview {
  /** path to the raw .cpuprofile (absolute back-pointer) */
  profile: string;
  scriptingMs: number;
  totalMs: number;
  sampleCount: number;
  sampleIntervalUs: number;
  system: CpuSystem;
  /** reconciling js/browser/gc/idle bar; absent on lanes without honest idle (Firefox) or old models */
  breakdown?: CpuBreakdown;
  byPackage: CpuGroupStat[];
  byFile: CpuGroupStat[];
  /** top functions by self time (length bounded by `--top`) */
  hot: CpuFunction[];
  dropped: CpuDropped;
  hints: string[];
}

/** One caller or callee of a function, with the time on that edge. */
export interface CpuEdgeRef {
  id: number;
  fn: string;
  ms: number;
}

/** `query frame <id>` output: the function plus its top callers and callees. */
export interface FrameQueryResult {
  function: CpuFunction;
  callers: CpuEdgeRef[];
  callees: CpuEdgeRef[];
}

/** One row of `query blame`: events sharing a source location, rolled up. */
export interface BlameEntry {
  /** source location "file:line:col" (relative to root) */
  at: string;
  count: number;
  /** how many of `count` were synchronously forced by JS (thrashing) */
  forced: number;
  durMs: number;
  kinds: EventKind[];
  /**
   * The DOM properties read at this line (Firefox read-site forced blame), e.g.
   * "HTMLElement.offsetWidth". Absent on lanes that do not name the forcing property (Chrome, which
   * names the read line but not the accessor).
   */
  properties?: string[];
  /**
   * The WRITE end of the forced-flush dual annotation: the mutation(s) that dirtied the DOM so this read forced
   * a synchronous flush. Chrome `--deep` only (its invalidation records name the write); absent on
   * every other lane. `at` is the read (who paid), `dirtiedBy` the write (who caused).
   */
  dirtiedBy?: DirtiedByWrite[];
}

/**
 * One span's slices in the single shape `query spans` reports across every engine. The keys are the
 * SUPERSET of what the two stored breakdown shapes carry (chrome's seven-slice `SpanBreakdown` and
 * the four/six-slice `CpuModel.breakdown`), so a matrix consumer reads the same field names on
 * chrome, firefox, and node.
 *
 * Honesty (the Measured<T> contract, see model/measured.ts): a slice a lane could not observe is an
 * explicit `null`, NEVER a fabricated 0. `style`/`layout` are null on the node lane (its four-slice
 * profile has no DOM work to split); `paint` is null whenever the span comes from a
 * `CpuModel.breakdown` (that bar carries no main-thread paint concept at all) AND on firefox stored
 * breakdowns, where paint is off-main-thread (a compositor side track, never summed into the wall).
 * So `paint` is null on every firefox span, stored bar or synthesized, and a consumer must treat it
 * as not-measured, never coerce it to 0.
 */
export interface UnifiedSlices {
  /** scripting self-time, split by owning package; measured on every lane */
  js: CpuJsSlice;
  /** style recalc; null when the lane did not split it (node) */
  style: Measured<CpuSlice>;
  /** layout/reflow; null when the lane did not split it (node) */
  layout: Measured<CpuSlice>;
  /** main-thread paint record; null when the source bar carries no paint concept (CpuModel.breakdown) */
  paint: Measured<CpuSlice>;
  /** garbage collection; measured on every lane */
  gc: CpuSlice;
  /** task remainder + unclassified (chrome `other`) / engine work unsplit (`browser`), unified */
  other: CpuSlice;
  /** the window not covered by any main-thread work; on a paint-terminated span this is vsync wait */
  idle: CpuSlice;
}

/**
 * One span in `query spans` output: the run window, a driver step, or a user `performance.measure`.
 * `Σ measured slices + idle` reconciles to `wallMs` (up to on-disk rounding dust or a `residualMs`),
 * the same closure the stored breakdowns promise.
 */
export interface SpanEntry {
  label: string;
  kind: SpanKind;
  /**
   * Headline wall (ms). On a stored per-span bar it is the trace-clock window the slices tile. On a
   * run span SYNTHESIZED from `CpuModel.breakdown` (`SpansResult.source === "cpu-model"`: default-rung
   * chrome, node, firefox without user measures) it is the profiler's own sampled window, which
   * brackets the whole timed loop INCLUDING the settle wait -- so it can exceed `summary.wallMs` (the
   * sum of the timed `run()` samples). The human header labels that case `sampled window`.
   */
  wallMs: number;
  /**
   * How this span's numbers combine the recording's timed iterations -- the one contract a consumer
   * needs before comparing spans, because a recording mixes them. `"sum"`: the window spans every
   * iteration, so slices/`wallMs` are a TOTAL across `iterations` (the run span: chrome's `wpd:run`
   * window covers the whole loop; the CpuModel-synthesized run brackets the whole timed loop).
   * `"first"`: the numbers describe ONE iteration -- a step span windowed to the FIRST timed iteration
   * (counts never scale with `--iterations`), or a `performance.measure` seen only once. `"median"`: a
   * `performance.measure` label that recurred, reported as the lower-median-by-wall occurrence (a real
   * reconciling sample, not per-slice averages); `samples`/`wallMinMs`/`wallMaxMs` disclose the merge.
   * At `iterations === 1` with no repeated measures the labels coincide; the label is still the
   * truthful one for the span.
   */
  aggregation: SpanAggregation;
  /** timed iterations behind this recording (`meta.iterations`); 1 unless `--iterations` repeated run() */
  iterations: number;
  slices: UnifiedSlices;
  /** off-thread compositor frame side track (chrome --breakdown only; absent otherwise). Display-only. */
  frames?: FrameSideTrack;
  /** carried through when the source breakdown did not fully close (lost events/clock skew) */
  residualMs?: number;
  /**
   * Real occurrences merged into this bar when `aggregation` is `"median"` (a repeated
   * `performance.measure` label). Absent for run/step spans and single-occurrence measures. Counts
   * real occurrences, not lookups: the bar IS one of these samples.
   */
  samples?: number;
  /** wall (ms) of the shortest merged occurrence; disclosed with `samples`. `wallMinMs <= wallMs <= wallMaxMs`. */
  wallMinMs?: number;
  /** wall (ms) of the longest merged occurrence; disclosed with `samples`. */
  wallMaxMs?: number;
}

/**
 * `query spans` output: one unified per-span breakdown array across chrome/firefox/node. `source`
 * says where the spans came from -- `breakdowns` (the recording's stored per-span bars: chrome
 * --breakdown, or firefox with user measures) or `cpu-model` (a single `run` span synthesized from
 * `CpuModel.breakdown` when no per-span bars were stored: firefox/node without measures, rung-1
 * chrome). The `run` span is always present when any bar exists, so this never comes back empty.
 */
export interface SpansResult {
  /** the --target axis this recording was produced on: chrome | firefox | node */
  target: string;
  source: "breakdowns" | "cpu-model";
  spans: SpanEntry[];
  /** how many spans the `query spans` flood filter (--min-wall/--filter) hid; 0 when no filter was
   * passed. Always present on the emitted view, so a filtered result is never a silent cut. */
  hidden?: number;
  /** the flood filter that produced `spans`; `{}` when none was passed. */
  filter?: { minWallMs?: number; labelIncludes?: string };
}

/** One forced (synchronous) layout/style read-site within a span, with the write(s) that dirtied it. */
export interface SpanForced {
  /** source location "file:line:col" of the geometry read that forced the flush (relative to root) */
  at: string;
  count: number;
  durMs: number;
  /** the mutation(s) that dirtied the DOM so this read forced a flush (chrome --deep only) */
  dirtiedBy?: DirtiedByWrite[];
}

/**
 * Hot functions within a span's window, on the CPU-sampler SCRIPTING axis (never the bar's `js`
 * slice; see model/recording.ts SpanHot). Three scopes:
 *  - `run-window`: the resolved CpuModel IS the run window (the sampler brackets the whole timed
 *    loop), so a run span reports its own hot list exactly. `pooledSamples` is the model's total
 *    sample count.
 *  - `step-window` / `measure-pooled`: read from the span's stored `SpanHot` refs, resolved to names
 *    via the sibling CpuModel `functions[]`. A step tallies its single iteration-0 window; a measure
 *    pools across `occurrences`. `functions` carry SPAN-LOCAL self time (`selfMs` = samples *
 *    interval, `selfPct` = share of `pooledSamples`); the `id` still indexes the model, so
 *    `query frame <id>` works.
 *
 * `suppressed` is true when the span had fewer than the pooled-sample floor: `functions` is omitted
 * (raise --iterations) rather than a fabricated top-N. A span whose CPU windowing is not
 * reconstructable at its rung/kind reports `hot: null` instead of this shape.
 */
export interface SpanHotFunctions {
  scope: "run-window" | "step-window" | "measure-pooled";
  /** JS self-time the shares denominate on: `run-window` the model's scriptingMs; else pooledSamples * interval */
  scriptingMs: number;
  /** ranked-JS samples the ranking is built from (`run-window`: the model's total sample count) */
  pooledSamples: number;
  /** occurrences pooled: N for a repeated measure, 1 for run/step */
  occurrences: number;
  /** true when no ranking was emitted: `functions` omitted. `suppressionReason` says why. */
  suppressed?: boolean;
  /**
   * Why a suppressed tally carries no `functions`, so the reader gets the right next step instead of a
   * blanket "raise --iterations":
   *  - `below-floor`: 0 < `pooledSamples` < the floor. A thin-but-real pool; raise --iterations.
   *  - `no-js`: `pooledSamples` 0 and the window ran essentially no JS. Nothing to rank, not an error.
   *  - `not-covered`: `pooledSamples` 0 but the bar attributes real JS to this window, so the sampler
   *    missed it. In driver mode the V8 CPU profiler resets on each cross-document navigation, so a
   *    window that ran before the run's last navigation carries no samples; raising --iterations
   *    cannot recover them.
   * Present only when `suppressed`.
   */
  suppressionReason?: "below-floor" | "no-js" | "not-covered";
  /** top functions by self time, length bounded by `--top`; absent when suppressed. Stored
   * per-span rows carry span-local selfMs/selfPct and no totalMs (a run-wide total beside a
   * span-local self would read as the span's own); the run-window list keeps CpuFunction whole. */
  functions?: (Omit<CpuFunction, "totalMs"> & { totalMs?: number })[];
}

/**
 * `query span <label>` output: one span's full anatomy. `slices` is the reconciling bar's unified
 * shape when the rung built one, else null (rung-honest, never fabricated). `counts` are Measured
 * throughout. `forced`/`thrash`/`firefoxDirtiedBy` are present only when an event-log rung (chrome
 * --deep, firefox) carried the records they read; `thrash` is the run window's layout-thrashing
 * rollup, chrome --deep only. `hot` is the span-windowed hot functions, or null when the CPU
 * windowing is not reconstructable at this rung/kind (see SpanHotFunctions). Span identity is
 * kind+label; a bare label matching more than one kind is a collision the caller resolves, never a
 * silent join.
 */
export interface SpanAnatomy {
  /** absolute back-pointer to the recording this anatomy was read from */
  recording: string;
  /** the --target axis: chrome | firefox | node */
  target: string;
  label: string;
  kind: SpanKind;
  aggregation: SpanAggregation;
  /** timed iterations behind this recording (`meta.iterations`) */
  iterations: number;
  wallMs: number | null;
  /** real occurrences merged into this span when `aggregation` is `"median"` (a repeated measure) */
  samples?: number;
  wallMinMs?: number;
  wallMaxMs?: number;
  /** the reconciling bar's unified slices; null when this rung built no bar for the span */
  slices: UnifiedSlices | null;
  /** carried through when the source breakdown did not fully close (lost events/clock skew) */
  residualMs?: number;
  /** off-thread compositor frame side track (chrome --breakdown only). Display-only. */
  frames?: FrameSideTrack;
  /** exact rendering counts windowed to this span's representative occurrence; Measured throughout */
  counts: SpanCounts;
  /** worst-interaction INP (ms) for a driver step; null when no interaction crossed the 16ms floor */
  inpMs?: number | null;
  /** in-page CWV split of `inpMs` (a driver step); absent when no interaction was observed */
  interaction?: InteractionTiming | null;
  /** forced read-sites in this span's window; present only on an event-log rung (chrome/firefox --deep) */
  forced?: SpanForced[];
  /** the layout-thrashing rollup for the run window (chrome --deep only, run span) */
  thrash?: ThrashReport;
  /** firefox --deep dirtied-by write report for this window (Gecko cause stacks, first-invalidation-only) */
  firefoxDirtiedBy?: FirefoxDirtiedByReport;
  /** hot functions within this span's window; null when not reconstructable at this rung/kind */
  hot: SpanHotFunctions | null;
  hints: string[];
}

/** Per-package self-time delta in a CPU diff. */
export interface CpuPackageDelta {
  package: string;
  baseMs: number;
  currentMs: number;
  delta: number;
}

/** Per-function self-time delta in a CPU diff. */
export interface CpuFunctionDelta {
  fn: string;
  source?: string;
  file?: string;
  package: string;
  baseMs: number;
  currentMs: number;
  delta: number;
}

/** `cpu-diff` output: net scripting delta plus per-package and per-function movers. */
export interface CpuDiffResult {
  baseline: { file: string; scriptingMs: number };
  current: { file: string; scriptingMs: number };
  /** per-function deltas below this (ms) are treated as sampling noise */
  noiseMs: number;
  netScriptingMs: number;
  netScriptingPct: number;
  byPackage: CpuPackageDelta[];
  functions: CpuFunctionDelta[];
}
