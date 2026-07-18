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
  EventKind,
  FrameSideTrack,
  SpanKind,
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
 * `CpuModel.breakdown` (that bar carries no main-thread paint concept at all). A measured 0 (e.g.
 * firefox `paint` in a stored `Breakdown`, genuinely 0 because paint is off the main thread there)
 * stays a 0, distinct from not-measured. This means null-vs-0 is not target-stable: on the SAME
 * firefox target `paint` is null on a run-only recording (the span is CpuModel-synthesized) but a
 * measured 0 once a stored breakdown exists, so a consumer normalizing across recordings should read
 * `paint?.ms ?? 0` rather than treat the distinction as a per-target signal.
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
  aggregation: "first" | "sum" | "median";
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
