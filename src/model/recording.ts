export type EventKind =
  | "layout"
  | "style"
  | "paint"
  | "composite"
  | "invalidation"
  | "scripting"
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

  layoutCount: number;
  layoutMs: number;
  styleCount: number;
  styleMs: number;
  paintCount: number;
  paintMs: number;
  compositeCount: number;
  compositeMs: number;

  layoutInvalidations: number;
  paintInvalidations: number;
  styleInvalidations: number;

  /** layout/style synchronously forced by JS (thrashing) */
  forcedLayoutCount: number;
  forcedLayoutMs: number;

  /** tasks >= 50ms ("long tasks") in the window */
  longTaskCount: number;
  longestTaskMs: number;

  scriptingMs: number;
  totalEvents: number;

  /** bench (in-page iterations) only: per-iteration wall times + their stats */
  perIteration: number[];
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
  /** driver (puppeteer) mode: run executed in Node with { page, ctx, measureStep } */
  driver: boolean;
  /** execution runtime: "chrome" (Puppeteer page) or "node" (in-process V8, CPU only) */
  runtime?: "chrome" | "node";
  /** artificial slowdown applied during the run */
  throttle?: { cpuRate?: number; network?: string };
  /** when this recording is one step of a stepped run */
  step?: { index: number; label: string };
  screenshots?: ScreenshotRefs;
}

export interface Recording {
  meta: RecordingMeta;
  window: RecordingWindow;
  marks: TimingEntry[];
  metrics: MetricsBlock;
  events: NormalizedEvent[];
  summary: RecordingSummary;
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
  hints: string[];
}

/** Entry-point file for a stepped (driver) run; points at per-step files. */
export interface StepIndexEntry {
  index: number;
  label: string;
  wallMs: number | null;
  inpMs: number | null;
  headline: {
    layoutCount: number;
    forcedLayoutCount: number;
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
  /** owning npm/workspace package, e.g. "react-dom", "next-yak", "app", "(native)" */
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
  /** functions sorted by self time descending; id is the index */
  functions: CpuFunction[];
  /** caller->callee edges (thresholded), for callers/callees drilling */
  edges: CpuEdge[];
}
