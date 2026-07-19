/**
 * Convert a Firefox Gecko "raw" shutdown-dump profile (format version 34) into the shapes the
 * rest of wpd already understands: a V8-style `RawCpuProfile` (fed to `buildCpuModel`) and, for
 * blame, `NormalizedEvent[]` from Reflow/Styles markers. Every field assumption here was verified
 * against a real dump; docs/dev/gecko-profile-format.md has the format details and the reasoning
 * behind each choice (thread selection, 1-based line/col, JS-only pruning, marker cause stacks).
 */

import type { NormalizedEvent } from "../model/recording.js";
import { msToUs } from "../model/time.js";
import {
  RUN_START_MARK,
  RUN_END_MARK,
  isRunOrStepEdgeMark,
  WPD_MARK_PREFIX,
} from "../model/marks.js";
import type { RawCallFrame, RawCpuProfile, RawProfileNode } from "./cpuprofile.js";
import type { GeckoMeasureWindow } from "./gecko-breakdown.js";

/** Raw trace-stack frame shape that trace/stacks.ts `extractStack` reads (1-based line/col). */
interface RawStackFrame {
  functionName?: string;
  url: string;
  lineNumber?: number;
  columnNumber?: number;
}

interface Table {
  schema: Record<string, number>;
  // frameTable's relevantForJS column is a boolean; the rest are numbers, strings, payloads, or null.
  data: (number | string | boolean | null | Record<string, unknown>)[][];
}

interface GeckoThread {
  processType?: number | string;
  name?: string;
  pid?: number;
  tid?: number;
  samples: Table;
  markers: Table;
  stackTable: Table;
  frameTable: Table;
  stringTable: string[];
}

interface GeckoContainer {
  meta?: {
    categories?: { name: string }[];
    interval?: number;
    /** unit of the samples `threadCPUDelta` column: "µs" (macOS), "ns", or "variable CPU cycles" */
    sampleUnits?: { threadCPUDelta?: string };
  };
  threads?: GeckoThread[];
  processes?: GeckoContainer[];
}

/** The reconciling breakdown slice a sample's wall-delta lands in (Firefox lane). `idle` comes from
 * the per-sample CPU-usage signal; style/layout/gc/js from the leaf-ward frame category; `other` is
 * DOM-accessor time, Profiler self-overhead, and everything else. Parallel to a converted profile's
 * `samples`, so summing `timeDeltas` by this classification tiles the profile window exactly. */
export type GeckoSlice = "js" | "style" | "layout" | "gc" | "idle" | "other";

/** Everything the two converters need, computed once so the JSON is walked a single time. */
export interface GeckoContext {
  thread: GeckoThread;
  jsCategory: number;
  idleCategory: number;
  /** Layout category index (covers both Reflow and style recalc frames); -1 if the dump lacks it. */
  layoutCategory: number;
  /** GC / CC category index; -1 if absent. */
  gcCategory: number;
  /** DOM category index (WebIDL accessor label frames land here); -1 if absent. */
  domCategory: number;
  intervalMs: number;
  /** unit of the samples `threadCPUDelta` column, read from meta.sampleUnits; null if not declared */
  cpuDeltaUnit: string | null;
  /** run window on the sample/marker ms clock; null when the wpd:run marks are absent */
  windowStartMs: number | null;
  windowEndMs: number | null;
}

/** CPU-usage below this (µs) counts as idle for a sample: the thread consumed ~no CPU since the
 * previous sample while wall-time advanced, i.e. it was descheduled (waiting). [measured, Firefox
 * 152, macOS, awaits-only 470ms pure-wait] eps 0 reads 94.5-95.7% idle, eps 100µs reads 99.1%;
 * 50µs sits between them as a conservative middle that tolerates the small mutex/IO CPU a sleeping
 * thread can still show (Bug 1689325) without fabricating idle. Never over-reports a busy sample:
 * real work reads ~one full interval (~1000µs) of CPU, far above this. */
const IDLE_CPU_DELTA_EPSILON_US = 50;

/** Convert a raw `threadCPUDelta` cell to microseconds using the dump's declared unit; null when
 * the cell is absent/null (old dumps, or a js-only feature set that leaves the column empty). A
 * "variable CPU cycles" unit is not a time, so its raw value is compared to the epsilon directly
 * (only ~0 cycles reads as idle), which is the sound direction: cycles ~0 means no work. */
function cpuDeltaToUs(raw: unknown, unit: string | null): number | null {
  if (typeof raw !== "number") return null;
  if (unit === "ns") return raw / 1000;
  // "µs"/"us" and the cycles fallback both compare the raw number against the µs epsilon.
  return raw;
}

/** Cycle guard for stackTable prefix walks: far above any real JS stack, so a corrupt
 * self-referencing dump cannot hang the converter. */
const MAX_STACK_DEPTH = 1024;

/** Parsed frame location: a resolvable JS url (http/https/file) keeps `url`; everything else
 * (native labels, self-hosted, resource:// internals, bare addresses) has an empty url and is
 * bucketed as (native) downstream, never fs-walked. Line/col are 1-based as Gecko writes them. */
interface ParsedLocation {
  functionName: string;
  url: string;
  line: number | null;
  column: number | null;
}

/** Only these url schemes are on-disk / fetchable source we resolve; see docs/dev/gecko-profile-format.md. */
function isResolvableUrl(url: string): boolean {
  return /^(https?|file):\/\//.test(url);
}

/**
 * Parse a Gecko frame `location` string. Forms observed:
 *   "name (url:line:col)"  named JS function (line:col = definition site, constant per function)
 *   "url:line:col"         anonymous top-level JS
 *   "url"                  script-level JS with no position
 *   "XRE_InitChildProcess" / "0x1180.." / "(root)"   native label (no url)
 * A trailing "[NN]" innerWindowID subscript is always stripped.
 */
export function parseGeckoLocation(rawLocation: string): ParsedLocation {
  const location = rawLocation.replace(/\[\d+\]$/, "");
  const named = location.match(/^(.*?) \((.+):(\d+):(\d+)\)$/);
  if (named) {
    const url = named[2];
    return isResolvableUrl(url)
      ? { functionName: named[1], url, line: Number(named[3]), column: Number(named[4]) }
      : { functionName: named[1] || location, url: "", line: null, column: null };
  }
  const positioned = location.match(/^(.+):(\d+):(\d+)$/);
  if (positioned && isResolvableUrl(positioned[1])) {
    return {
      functionName: "",
      url: positioned[1],
      line: Number(positioned[2]),
      column: Number(positioned[3]),
    };
  }
  if (isResolvableUrl(location))
    return { functionName: "", url: location, line: null, column: null };
  return { functionName: location, url: "", line: null, column: null };
}

/** Walk parent + child processes (they nest recursively) and collect every thread. */
function allThreads(container: GeckoContainer): GeckoThread[] {
  const threads: GeckoThread[] = [...(container.threads ?? [])];
  for (const child of container.processes ?? []) threads.push(...allThreads(child));
  return threads;
}

/** UserTiming marker label (a performance.mark/measure name) for a marker row, or null. */
function userTimingName(
  thread: GeckoThread,
  markerRow: (number | string | boolean | null | Record<string, unknown>)[],
): string | null {
  const nameColumn = thread.markers.schema.name;
  if (thread.stringTable[markerRow[nameColumn] as number] !== "UserTiming") return null;
  const data = markerRow[thread.markers.schema.data] as { name?: string } | null;
  return typeof data?.name === "string" ? data.name : null;
}

/** The [start,end] ms window from this thread's wpd:run UserTiming markers. */
function runWindow(thread: GeckoThread): { startMs: number | null; endMs: number | null } {
  const startColumn = thread.markers.schema.startTime;
  let startMs: number | null = null;
  let endMs: number | null = null;
  for (const markerRow of thread.markers.data) {
    const label = userTimingName(thread, markerRow);
    if (label === RUN_START_MARK) startMs = markerRow[startColumn] as number;
    else if (label === RUN_END_MARK) endMs = markerRow[startColumn] as number;
  }
  return { startMs, endMs };
}

/**
 * Locate the content thread that ran the module (the one carrying the wpd:run marks) and
 * compute the shared context. Selecting by marker, not by processType, is robust across the
 * several content processes Firefox spawns (see docs/dev/gecko-profile-format.md).
 */
export function parseGecko(profile: GeckoContainer): GeckoContext {
  const categories = profile.meta?.categories ?? [];
  const jsCategory = categories.findIndex((category) => category.name === "JavaScript");
  const idleCategory = categories.findIndex((category) => category.name === "Idle");
  // Both Reflow and style recalc frames carry the "Layout" category; style vs layout is split by
  // frame name downstream. "GC / CC" is Gecko's gc/cycle-collector category; "DOM" carries the
  // WebIDL accessor label frames (get HTMLElement.offsetWidth) read-site blame keys on.
  const layoutCategory = categories.findIndex((category) => category.name === "Layout");
  const gcCategory = categories.findIndex((category) => category.name === "GC / CC");
  const domCategory = categories.findIndex((category) => category.name === "DOM");
  const intervalMs = profile.meta?.interval ?? 1;
  const cpuDeltaUnit = profile.meta?.sampleUnits?.threadCPUDelta ?? null;
  // Without the JavaScript category no frame can be classified as JS, which would yield an
  // empty-but-valid CPU model reporting ~0 scripting time. Fail loudly instead of lying.
  if (jsCategory < 0) {
    throw new Error(
      "Gecko profile has no 'JavaScript' category: the dump is not a profile wpd can read (unsupported format version, or the 'js' profiler feature was off).",
    );
  }

  const threads = allThreads(profile);
  if (threads.length === 0)
    throw new Error("Gecko profile contains no threads: the dump is empty or not a Gecko profile.");
  let chosen: GeckoThread | undefined;
  let window = { startMs: null as number | null, endMs: null as number | null };
  for (const thread of threads) {
    const candidate = runWindow(thread);
    if (candidate.startMs != null) {
      chosen = thread;
      window = candidate;
      break;
    }
  }
  // Fallback: no wpd marks found (should not happen in practice). Use the thread with the most
  // samples so the CPU model is still populated, and leave the window open (unsliced).
  if (!chosen) {
    chosen = threads.reduce((best, thread) =>
      thread.samples.data.length > best.samples.data.length ? thread : best,
    );
  }
  return {
    thread: chosen,
    jsCategory,
    idleCategory,
    layoutCategory,
    gcCategory,
    domCategory,
    intervalMs,
    cpuDeltaUnit,
    windowStartMs: window.startMs,
    windowEndMs: window.endMs,
  };
}

/** Info a frame contributes: whether it is JS, its call-frame identity (definition site, from the
 * location string), and the per-sample execution line/col (frameTable columns). CPU node identity
 * uses the definition site (function-level collapsing, like V8); marker blame uses the execution
 * line so a forced layout points at the exact offending statement (Chrome-parity). */
interface FrameInfo {
  isJs: boolean;
  isIdle: boolean;
  /** frameTable category index, or null when the frame carries none (unsymbolicated native leaves) */
  category: number | null;
  /** WebIDL "relevant for JS" flag: true on DOM accessor label frames (get HTMLElement.offsetWidth) */
  relevantForJS: boolean;
  /** raw location string, kept for the read-site property name and style/layout name split */
  rawLocation: string;
  parsed: ParsedLocation;
  /** 1-based executing line/col at this sample (null when Gecko did not record them) */
  execLine: number | null;
  execColumn: number | null;
}

function readFrame(context: GeckoContext, frameIndex: number): FrameInfo {
  const { thread, jsCategory, idleCategory } = context;
  const frameRow = thread.frameTable.data[frameIndex];
  const schema = thread.frameTable.schema;
  const rawCategory = frameRow[schema.category];
  const category = typeof rawCategory === "number" ? rawCategory : null;
  const location = String(thread.stringTable[frameRow[schema.location] as number] ?? "");
  const execLine = frameRow[schema.line];
  const execColumn = frameRow[schema.column];
  return {
    isJs: category === jsCategory,
    isIdle: category === idleCategory,
    category,
    relevantForJS: frameRow[schema.relevantForJS] === true,
    rawLocation: location,
    parsed: parseGeckoLocation(location),
    execLine: typeof execLine === "number" ? execLine : null,
    execColumn: typeof execColumn === "number" ? execColumn : null,
  };
}

/** Split a Layout-category frame into the style vs layout slice by its label. Gecko emits both style
 * recalc and reflow under the one Layout category, so the label decides. Style: the servo recalc
 * scopes (`Styles`/`Style computation`/`CSS parsing`/`Container Query...`), the restyle-pass and
 * style-diff wrappers (`RestyleManager::...`/`ComputedStyle::CalcStyleDifference`), the stylist
 * rebuild (`Update stylesheet information`, cascade-data rebuild Chrome folds into Recalculate
 * style; see docs/dev/engine-mapping.md), and a ` Style`-suffixed flush wrapper
 * (`PresShell::DoFlushPendingNotifications Style`). Everything else is layout (`Reflow ...`, the
 * ` Layout` flush wrapper, frame construction). Without these style wrappers ~10-25% of style recalc
 * on a style-bound workload buckets to layout. Matching stays anchored (prefix/suffix/exact): a bare
 * `Style` substring would wrongly claim the `CTFontFamily::FindStyleVariations` font-matching frame. */
export function layoutSlice(rawLocation: string): "style" | "layout" {
  return /^(Styles|Style computation|CSS parsing|Container Query|Update stylesheet information|RestyleManager::|ComputedStyle::CalcStyleDifference)/.test(
    rawLocation,
  ) || rawLocation.endsWith(" Style")
    ? "style"
    : "layout";
}

/** The breakdown slice for a sample, from the nearest-to-leaf categorized frame in its full stack
 * (the Firefox Profiler's own "Categories" semantic). Unsymbolicated native leaves carry no
 * category, so the walk skips them until it finds a categorized frame; a stack with none is `other`.
 * The idle decision is made by the caller from `threadCPUDelta`, not here. */
function sampleSlice(context: GeckoContext, stackIndex: number | null): GeckoSlice {
  if (stackIndex == null) return "idle";
  const { thread, jsCategory, idleCategory, layoutCategory, gcCategory } = context;
  const schema = thread.stackTable.schema;
  let current: number | null = stackIndex;
  let guard = 0;
  while (current != null && guard++ < MAX_STACK_DEPTH) {
    const stackRow = thread.stackTable.data[current];
    const info = readFrame(context, stackRow[schema.frame] as number);
    if (info.category != null) {
      if (info.category === idleCategory) return "idle";
      if (info.category === layoutCategory) return layoutSlice(info.rawLocation);
      if (info.category === gcCategory) return "gc";
      if (info.category === jsCategory) return "js";
      // DOM accessor time, Profiler self-overhead, Graphics, Other, etc. are engine/runtime work.
      return "other";
    }
    current = stackRow[schema.prefix] as number | null;
  }
  return "other";
}

/** The JS-only frame chain (root..leaf) for a Gecko stack index; native frames are dropped so
 * the result mirrors a V8 JS-only profile. Cached: many samples share stack prefixes. */
function jsChainRootFirst(
  context: GeckoContext,
  stackIndex: number,
  cache: Map<number, ParsedLocation[]>,
): ParsedLocation[] {
  const cached = cache.get(stackIndex);
  if (cached) return cached;
  const { thread } = context;
  const schema = thread.stackTable.schema;
  const leafFirst: ParsedLocation[] = [];
  let current: number | null = stackIndex;
  let guard = 0;
  while (current != null && guard++ < MAX_STACK_DEPTH) {
    const stackRow = thread.stackTable.data[current];
    const info = readFrame(context, stackRow[schema.frame] as number);
    if (info.isJs) leafFirst.push(info.parsed);
    current = stackRow[schema.prefix] as number | null;
  }
  const rootFirst = leafFirst.reverse();
  cache.set(stackIndex, rootFirst);
  return rootFirst;
}

function toRawCallFrame(parsed: ParsedLocation): RawCallFrame {
  // resolveCallFrame adds 1 (CDP 0-based convention), so store line/col 0-based. When the
  // location string had no position (script-level frame), fall back to 0 -> resolves to line 1.
  return {
    functionName: parsed.functionName || "(anonymous)",
    scriptId: "0",
    url: parsed.url,
    lineNumber: parsed.line != null ? parsed.line - 1 : 0,
    columnNumber: parsed.column != null ? parsed.column - 1 : 0,
  };
}

/** A synthetic V8-style bookkeeping frame ((root)/(program)/(idle)): no url, no position. */
const systemCallFrame = (name: string): RawCallFrame => ({
  functionName: name,
  scriptId: "0",
  url: "",
  lineNumber: -1,
  columnNumber: -1,
});

/** Identity of a JS frame for interning the pruned call tree (function-level, so all samples in
 * one function collapse to one node like V8). */
function chainFrameKey(parsed: ParsedLocation): string {
  return `${parsed.functionName}|${parsed.url}|${parsed.line}|${parsed.column}`;
}

/**
 * Build a V8-style `RawCpuProfile` from the Gecko context, restricted to the run window. Samples
 * are reduced to their JS frame chains and interned into a fresh prefix tree under a synthetic
 * (root); non-JS samples fall to (program) / (idle). Self time is the per-sample wall delta.
 */
export function geckoToRawCpuProfile(context: GeckoContext): RawCpuProfile {
  const { thread, windowStartMs, windowEndMs } = context;
  const sampleSchema = thread.samples.schema;

  const nodes: RawProfileNode[] = [];
  const childSets: Set<number>[] = [];
  const nodeByPath = new Map<string, number>();
  const addNode = (callFrame: RawCallFrame): number => {
    const id = nodes.length;
    nodes.push({ id, callFrame, children: [] });
    childSets.push(new Set());
    return id;
  };
  const rootId = addNode(systemCallFrame("(root)"));
  const programId = addNode(systemCallFrame("(program)"));
  const idleId = addNode(systemCallFrame("(idle)"));
  childSets[rootId].add(programId);
  childSets[rootId].add(idleId);

  const internChain = (chainRootFirst: ParsedLocation[]): number => {
    let parentId = rootId;
    let pathKey = "(root)";
    for (const parsed of chainRootFirst) {
      pathKey += `\n${chainFrameKey(parsed)}`;
      let nodeId = nodeByPath.get(pathKey);
      if (nodeId == null) {
        nodeId = addNode(toRawCallFrame(parsed));
        nodeByPath.set(pathKey, nodeId);
        childSets[parentId].add(nodeId);
      }
      parentId = nodeId;
    }
    return parentId;
  };

  const chainCache = new Map<number, ParsedLocation[]>();
  const samples: number[] = [];
  const timeDeltas: number[] = [];
  const sampleSlices: GeckoSlice[] = [];
  // The `threadCPUDelta` column is present only when the profiler ran with the `cpu` feature; a
  // js-only dump leaves it absent/empty. Its populated-ness gates the honest-idle breakdown: with no
  // CPU signal we cannot tell a descheduled wait from `(program)`, so no breakdown is emitted rather
  // than a fabricated idle.
  const cpuDeltaColumn = sampleSchema.threadCPUDelta;
  let cpuDeltaPopulated = false;

  let previousTimeMs: number | null = null;
  let windowStartUs: number | null = null;
  let windowEndUs: number | null = null;
  for (const sampleRow of thread.samples.data) {
    const timeMs = sampleRow[sampleSchema.time] as number;
    const deltaMs = previousTimeMs == null ? context.intervalMs : timeMs - previousTimeMs;
    previousTimeMs = timeMs;
    if (windowStartMs != null && timeMs < windowStartMs) continue;
    if (windowEndMs != null && timeMs > windowEndMs) continue;

    const stackIndex = sampleRow[sampleSchema.stack] as number | null;
    const cpuDeltaUs =
      cpuDeltaColumn != null ? cpuDeltaToUs(sampleRow[cpuDeltaColumn], context.cpuDeltaUnit) : null;
    if (cpuDeltaUs != null) cpuDeltaPopulated = true;
    // Honest idle: a sample that burned ~no CPU since the previous one was descheduled (waiting),
    // so its wall-delta is idle regardless of what frame sat on the stack. Route it to the (idle)
    // node so system.idleMs / scriptingMs are honest, and classify its slice as idle.
    const idleByCpu = cpuDeltaUs != null && cpuDeltaUs <= IDLE_CPU_DELTA_EPSILON_US;

    let nodeId: number;
    let slice: GeckoSlice;
    if (idleByCpu || stackIndex == null) {
      nodeId = idleId;
      slice = "idle";
    } else {
      const chain = jsChainRootFirst(context, stackIndex, chainCache);
      if (chain.length === 0) {
        const leaf = readFrame(
          context,
          thread.stackTable.data[stackIndex][thread.stackTable.schema.frame] as number,
        );
        nodeId = leaf.isIdle ? idleId : programId;
      } else {
        nodeId = internChain(chain);
      }
      slice = sampleSlice(context, stackIndex);
    }
    const deltaUs = msToUs(Math.max(0, deltaMs));
    samples.push(nodeId);
    timeDeltas.push(deltaUs);
    sampleSlices.push(slice);
    if (windowStartUs == null) windowStartUs = msToUs(timeMs);
    windowEndUs = msToUs(timeMs);
  }

  for (let nodeId = 0; nodeId < nodes.length; nodeId++)
    nodes[nodeId].children = [...childSets[nodeId]];

  return {
    nodes,
    startTime: windowStartUs ?? (windowStartMs != null ? msToUs(windowStartMs) : 0),
    endTime: windowEndUs ?? (windowEndMs != null ? msToUs(windowEndMs) : 0),
    samples,
    timeDeltas,
    // Only when the CPU column was populated: the reconciling breakdown needs the idle signal, and
    // without it a firefox bar would fabricate idle. Chrome/node profiles never set this field.
    gecko: cpuDeltaPopulated ? { sampleSlices } : undefined,
  };
}

/** Kind + display name for a rendering marker, or null if it is not one we surface. */
function renderingKind(markerName: string): { kind: "layout" | "style"; name: string } | null {
  if (markerName === "Styles") return { kind: "style", name: "RecalcStyles" };
  if (markerName.startsWith("Reflow")) return { kind: "layout", name: "Layout" };
  return null;
}

/** Resolve a marker cause-stack index to JS frames (1-based, trace-stack convention), leaf frame
 * first so `topLocation`/blame pick the innermost JS caller. */
function causeStackFrames(context: GeckoContext, stackIndex: number): RawStackFrame[] {
  const { thread } = context;
  const schema = thread.stackTable.schema;
  const frames: RawStackFrame[] = [];
  let current: number | null = stackIndex;
  let guard = 0;
  while (current != null && guard++ < MAX_STACK_DEPTH) {
    const stackRow = thread.stackTable.data[current];
    const info = readFrame(context, stackRow[schema.frame] as number);
    if (info.isJs && info.parsed.url) {
      // Prefer the executing line/col (exact offending statement) over the function definition
      // site, so forced-layout blame points at the read/write that triggered the flush.
      frames.push({
        functionName: info.parsed.functionName || undefined,
        url: info.parsed.url,
        lineNumber: info.execLine ?? info.parsed.line ?? undefined,
        columnNumber: info.execColumn ?? info.parsed.column ?? undefined,
      });
    }
    current = stackRow[schema.prefix] as number | null;
  }
  // Already leaf-first: the stack walk goes child -> parent.
  return frames;
}

/**
 * Turn the run window's UserTiming + Reflow/Styles markers into NormalizedEvents so the existing
 * pipeline (attachStacks -> markForced -> buildSummary/blame/digest) works unchanged. UserTiming
 * marks become `usertiming` events (so findWindow/findSteps locate the window); Reflow -> layout,
 * Styles -> style, each carrying its JS cause as args.data.stackTrace for source attribution.
 * When a JS frame is on the cause stack the event resolves an `at`, which markForced reads as a
 * synchronously-forced (thrashing) layout/style.
 */
export function geckoToRenderingEvents(context: GeckoContext): NormalizedEvent[] {
  const { thread, windowStartMs, windowEndMs } = context;
  const schema = thread.markers.schema;
  const inWindow = (timeMs: number) =>
    (windowStartMs == null || timeMs >= windowStartMs) &&
    (windowEndMs == null || timeMs <= windowEndMs);

  // Reflow markers split into phase-2 (start, has the cause) / phase-3 (end) rows; pair them via
  // a stack keyed by marker name so nested reflows match. Styles use a single phase-1 interval.
  const openStarts = new Map<string, { startMs: number; causeIndex: number | null }[]>();
  // Ids are assigned in ts order once the markers are sorted below, so push a placeholder here.
  const events: NormalizedEvent[] = [];

  for (const markerRow of thread.markers.data) {
    const markerName = String(thread.stringTable[markerRow[schema.name] as number] ?? "");
    const phase = markerRow[schema.phase] as number;
    const startTime = markerRow[schema.startTime] as number;
    const endTime = markerRow[schema.endTime] as number;
    const data = markerRow[schema.data] as {
      name?: string;
      stack?: { samples?: { data?: number[][] } };
    } | null;

    const label = userTimingName(thread, markerRow);
    if (label) {
      // Only surface the marks the pipeline windows on (run/step); skip other user marks.
      if (!isRunOrStepEdgeMark(label)) continue;
      if (!inWindow(startTime)) continue;
      events.push({
        id: 0,
        name: label,
        ts: msToUs(startTime),
        dur: 0,
        ph: "R",
        kind: "usertiming",
      });
      continue;
    }

    const rendering = renderingKind(markerName);
    if (!rendering) continue;
    const causeIndex = data?.stack?.samples?.data?.[0]?.[0] ?? null;

    if (phase === 2) {
      // interval start (Reflow): stash until the matching end row.
      const pending = openStarts.get(markerName) ?? [];
      pending.push({ startMs: startTime, causeIndex });
      openStarts.set(markerName, pending);
      continue;
    }
    let effectiveStartMs = startTime;
    let effectiveCause = causeIndex;
    let effectiveEndMs = endTime;
    if (phase === 3) {
      const pending = openStarts.get(markerName);
      const opened = pending?.pop();
      if (!opened) continue;
      effectiveStartMs = opened.startMs;
      effectiveCause = opened.causeIndex;
      effectiveEndMs = endTime;
    } else if (phase === 1) {
      effectiveStartMs = startTime;
      effectiveEndMs = endTime;
    } else {
      // Instant rendering markers carry no duration.
      continue;
    }
    if (!inWindow(effectiveStartMs)) continue;

    const durationMs = Math.max(0, effectiveEndMs - effectiveStartMs);
    const causeFrames = effectiveCause != null ? causeStackFrames(context, effectiveCause) : [];
    events.push({
      id: 0,
      name: rendering.name,
      ts: msToUs(effectiveStartMs),
      dur: msToUs(durationMs),
      ph: "X",
      kind: rendering.kind,
      // A JS cause proves this flush was synchronously forced, so it drives forcedLayoutCount. The
      // cause names the WRITE that dirtied the DOM, not the read that forced the flush, so it is
      // deliberately NOT surfaced as `at`: that would put write lines in `query blame --forced`,
      // where the sampled read-site events below carry the read line instead. The write cause stays
      // reachable via `query get`/`query events` under args.data.invalidationStack.
      forced: causeFrames.length > 0,
      args: causeFrames.length ? { data: { invalidationStack: causeFrames } } : undefined,
    });
  }

  // Read-site forced blame from the sampled stacks: the answer `query blame --forced` shows on
  // Firefox (the read line + property), matching Chrome's flush-site semantics. Additive to the
  // marker events above, which keep providing the flush COUNTS.
  events.push(...geckoReadSiteBlameEvents(context));

  events.sort((left, right) => left.ts - right.ts);
  // Reassign ids in ts order for stable `query get <id>` addressing (parseTrace does the same).
  events.forEach((event, index) => {
    event.id = index;
  });
  return events;
}

/** The clean property name from a DOM accessor label frame ("get HTMLElement.offsetWidth" ->
 * "HTMLElement.offsetWidth"; a method label with no leading get/set keyword is returned as-is). */
function readSiteProperty(rawLocation: string): string {
  const spaceAt = rawLocation.indexOf(" ");
  return spaceAt >= 0 ? rawLocation.slice(spaceAt + 1) : rawLocation;
}

interface ReadSite {
  kind: "style" | "layout";
  frame: RawStackFrame;
  property: string;
}

/**
 * Read-site forced-layout blame from ONE sample's stack, or null if the sample is not a forced read.
 * Walking leaf -> root: a Layout-category frame (Reflow/Styles) is the "this read forced a flush"
 * discriminator; the DOM-category accessor label above it names the property; the nearest JS
 * ancestor above the accessor carries the per-sample EXECUTING line (`frameTable.line`), which is
 * the read site (matching Chrome's flush-site blame), NOT the function-definition line.
 */
function readSiteFromStack(context: GeckoContext, stackIndex: number): ReadSite | null {
  const { thread, layoutCategory, domCategory } = context;
  const schema = thread.stackTable.schema;
  let current: number | null = stackIndex;
  let guard = 0;
  let forcedKind: "style" | "layout" | null = null;
  let property: string | null = null;
  while (current != null && guard++ < MAX_STACK_DEPTH) {
    const stackRow = thread.stackTable.data[current];
    const info = readFrame(context, stackRow[schema.frame] as number);
    if (property != null) {
      // Past the accessor: the first JS ancestor with an executing line is the read site.
      if (info.isJs && info.parsed.url && info.execLine != null) {
        return {
          kind: forcedKind!,
          frame: {
            functionName: info.parsed.functionName || undefined,
            url: info.parsed.url,
            lineNumber: info.execLine,
            columnNumber: info.execColumn ?? undefined,
          },
          property,
        };
      }
    } else if (layoutCategory >= 0 && info.category === layoutCategory) {
      forcedKind = layoutSlice(info.rawLocation);
    } else if (
      domCategory >= 0 &&
      info.category === domCategory &&
      info.relevantForJS &&
      forcedKind &&
      // Only READ accessors force a flush; `set*` writes (bump's style assignments) dirty layout but
      // do not force it, and blaming them would put write lines in --forced. GL-1: reads and writes
      // never collide once set* is excluded.
      !info.rawLocation.startsWith("set ")
    ) {
      property = readSiteProperty(info.rawLocation);
    }
    current = stackRow[schema.prefix] as number | null;
  }
  return null;
}

/**
 * Sampled read-site forced-layout/style blame events (Firefox). One per sample whose stack shows a
 * DOM geometry read sitting over a Layout-category flush; each carries the read line (via
 * args.data.stackTrace, resolved by attachStacks) and the property name. Marked `sampled` so the
 * summary does not count them as flushes (the Reflow/Styles markers do that); they exist for blame.
 * The per-sample wall delta mirrors the converter's, so grouped durations read as sampled time.
 */
export function geckoReadSiteBlameEvents(context: GeckoContext): NormalizedEvent[] {
  const { thread, windowStartMs, windowEndMs } = context;
  const sampleSchema = thread.samples.schema;
  const events: NormalizedEvent[] = [];
  let previousTimeMs: number | null = null;
  for (const sampleRow of thread.samples.data) {
    const timeMs = sampleRow[sampleSchema.time] as number;
    const deltaMs = previousTimeMs == null ? context.intervalMs : timeMs - previousTimeMs;
    previousTimeMs = timeMs;
    if (windowStartMs != null && timeMs < windowStartMs) continue;
    if (windowEndMs != null && timeMs > windowEndMs) continue;
    const stackIndex = sampleRow[sampleSchema.stack] as number | null;
    if (stackIndex == null) continue;
    const readSite = readSiteFromStack(context, stackIndex);
    if (!readSite) continue;
    events.push({
      id: 0,
      name: readSite.kind === "style" ? "RecalcStyles" : "Layout",
      ts: msToUs(timeMs),
      dur: msToUs(Math.max(0, deltaMs)),
      ph: "X",
      kind: readSite.kind,
      sampled: true,
      args: { data: { stackTrace: [readSite.frame], property: readSite.property } },
    });
  }
  return events;
}

/**
 * User `performance.measure` spans inside the run window (the §14 mark bridge on Firefox). Read from
 * UserTiming interval markers (`data.entryType === "measure"`, phase 1). wpd's own `wpd:*` measures
 * are excluded (the run/step spans come from marks). Times are converted to the profiler µs clock,
 * the same clock the samples carry, so the breakdown builder can window them directly.
 */
export function geckoUserMeasures(context: GeckoContext): GeckoMeasureWindow[] {
  const { thread, windowStartMs, windowEndMs } = context;
  const schema = thread.markers.schema;
  const measures: GeckoMeasureWindow[] = [];
  for (const markerRow of thread.markers.data) {
    if (thread.stringTable[markerRow[schema.name] as number] !== "UserTiming") continue;
    const data = markerRow[schema.data] as { name?: string; entryType?: string } | null;
    if (data?.entryType !== "measure" || typeof data.name !== "string") continue;
    const label = data.name;
    if (label.startsWith(WPD_MARK_PREFIX)) continue;
    const startMs = markerRow[schema.startTime];
    const endMs = markerRow[schema.endTime];
    if (typeof startMs !== "number" || typeof endMs !== "number" || endMs <= startMs) continue;
    if (windowStartMs != null && startMs < windowStartMs) continue;
    if (windowEndMs != null && endMs > windowEndMs) continue;
    // EVERY in-window occurrence is kept, including a label repeated once per --iteration: those
    // repetitions are the label's samples, merged per label downstream (see model/span-merge.ts).
    measures.push({ label, startTs: msToUs(startMs), endTs: msToUs(endMs) });
  }
  return measures;
}
