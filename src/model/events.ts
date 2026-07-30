import type { DirtiedByWrite } from "./attribution.js";

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
  /**
   * The frame carries an executing LINE but no observed column (a CPU sample's `data.lines` entry, the
   * chrome --breakdown sampled read-site). A source-map lookup must NOT assume generated column 0 for
   * it: on a minified single-line bundle every column-0 lookup resolves to whatever segment starts the
   * line, an unrelated original location. resolveFrame maps a line-only frame only when its generated
   * line is unambiguous. Absent (the usual) means the column was observed and column 0 is real.
   */
  lineOnly?: boolean;
  /**
   * A column-bearing fallback position for a `lineOnly` sampled read-site: the leaf FUNCTION's own
   * callFrame line+column (1-based), the same frame the CPU model resolves. When the executing line
   * cannot be disambiguated (a minified bundle joins whole modules onto one generated line, so a
   * column-less lookup is ambiguous), resolveFrame retries at this position and names the forcing
   * function at line granularity instead of keeping the bundle line. Only the sampled-blame path sets
   * it; absent everywhere else.
   */
  fallbackLine?: number;
  fallbackColumn?: number;
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
