import type { NormalizedEvent } from "../model/recording.js";
import type { RawCallFrame, RawCpuProfile, RawProfileNode } from "./cpuprofile.js";

/** Raw trace-stack frame shape that trace/stacks.ts `extractStack` reads (1-based line/col). */
interface RawStackFrame {
  functionName?: string;
  url: string;
  lineNumber?: number;
  columnNumber?: number;
}

/**
 * Convert a Firefox Gecko "raw" shutdown-dump profile (format version 34) into the shapes the
 * rest of wpd already understands: a V8-style `RawCpuProfile` (fed to `buildCpuModel`) and, for
 * blame, `NormalizedEvent[]` from Reflow/Styles markers. Every field assumption here was verified
 * against a real dump; see docs/dev/gecko-profile-format.md for the format details and the reasoning behind each
 * choice (thread selection, 1-based line/col, JS-only frame pruning, marker cause stacks).
 */

interface Table {
  schema: Record<string, number>;
  data: (number | string | null | Record<string, unknown>)[][];
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
  meta?: { categories?: { name: string }[]; interval?: number };
  threads?: GeckoThread[];
  processes?: GeckoContainer[];
}

/** Everything the two converters need, computed once so the JSON is walked a single time. */
export interface GeckoContext {
  thread: GeckoThread;
  jsCategory: number;
  idleCategory: number;
  intervalMs: number;
  /** run window on the sample/marker ms clock; null when the wpd:run marks are absent */
  windowStartMs: number | null;
  windowEndMs: number | null;
}

/** wpd marks land on the same ms clock; NormalizedEvent.ts is the microsecond trace clock. */
const MS_TO_US = 1000;

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
  markerRow: (number | string | null | Record<string, unknown>)[],
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
    if (label === "wpd:run:start") startMs = markerRow[startColumn] as number;
    else if (label === "wpd:run:end") endMs = markerRow[startColumn] as number;
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
  const intervalMs = profile.meta?.interval ?? 1;

  const threads = allThreads(profile);
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
    chosen = threads.reduce(
      (best, thread) =>
        thread.samples.data.length > (best?.samples.data.length ?? -1) ? thread : best,
      threads[0],
    );
  }
  return {
    thread: chosen,
    jsCategory,
    idleCategory,
    intervalMs,
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
  parsed: ParsedLocation;
  /** 1-based executing line/col at this sample (null when Gecko did not record them) */
  execLine: number | null;
  execColumn: number | null;
}

function readFrame(context: GeckoContext, frameIndex: number): FrameInfo {
  const { thread, jsCategory, idleCategory } = context;
  const frameRow = thread.frameTable.data[frameIndex];
  const schema = thread.frameTable.schema;
  const category = frameRow[schema.category] as number;
  const location = thread.stringTable[frameRow[schema.location] as number] ?? "";
  const execLine = frameRow[schema.line];
  const execColumn = frameRow[schema.column];
  return {
    isJs: category === jsCategory,
    isIdle: category === idleCategory,
    parsed: parseGeckoLocation(String(location)),
    execLine: typeof execLine === "number" ? execLine : null,
    execColumn: typeof execColumn === "number" ? execColumn : null,
  };
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
  while (current != null && guard++ < 1024) {
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

const SYSTEM_CALL_FRAME = (name: string): RawCallFrame => ({
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
  const rootId = addNode(SYSTEM_CALL_FRAME("(root)"));
  const programId = addNode(SYSTEM_CALL_FRAME("(program)"));
  const idleId = addNode(SYSTEM_CALL_FRAME("(idle)"));
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
    let nodeId: number;
    if (stackIndex == null) {
      nodeId = idleId;
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
    }
    const deltaUs = Math.max(0, deltaMs) * MS_TO_US;
    samples.push(nodeId);
    timeDeltas.push(deltaUs);
    if (windowStartUs == null) windowStartUs = timeMs * MS_TO_US;
    windowEndUs = timeMs * MS_TO_US;
  }

  for (let nodeId = 0; nodeId < nodes.length; nodeId++)
    nodes[nodeId].children = [...childSets[nodeId]];

  return {
    nodes,
    startTime: windowStartUs ?? (windowStartMs != null ? windowStartMs * MS_TO_US : 0),
    endTime: windowEndUs ?? (windowEndMs != null ? windowEndMs * MS_TO_US : 0),
    samples,
    timeDeltas,
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
  while (current != null && guard++ < 1024) {
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
  return frames; // leaf-first already (stack walks child -> parent)
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
  const events: NormalizedEvent[] = [];
  let nextId = 0;

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
      if (!/^wpd:(run|step:\d+):(start|end)$/.test(label)) continue;
      if (!inWindow(startTime)) continue;
      events.push({
        id: nextId++,
        name: label,
        ts: startTime * MS_TO_US,
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
      continue; // instant rendering markers carry no duration; skip
    }
    if (!inWindow(effectiveStartMs)) continue;

    const durationMs = Math.max(0, effectiveEndMs - effectiveStartMs);
    const stackTrace = effectiveCause != null ? causeStackFrames(context, effectiveCause) : [];
    events.push({
      id: nextId++,
      name: rendering.name,
      ts: effectiveStartMs * MS_TO_US,
      dur: durationMs * MS_TO_US,
      ph: "X",
      kind: rendering.kind,
      // Mimic the Chrome trace arg shape so attachStacks() resolves it unchanged.
      args: stackTrace.length ? { data: { stackTrace } } : undefined,
    });
  }

  events.sort((left, right) => left.ts - right.ts);
  // Reassign ids in ts order for stable `query get <id>` addressing (parseTrace does the same).
  events.forEach((event, index) => {
    event.id = index;
  });
  return events;
}
