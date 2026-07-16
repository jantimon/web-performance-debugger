import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  CpuEdge,
  CpuFunction,
  CpuGroupStat,
  CpuModel,
  RecordingMeta,
  StackFrame,
} from "../model/recording.js";
import {
  makeSourceResolver,
  makeNodeSourceResolver,
  relativizeSource,
  isToolFrameUrl,
} from "../trace/stacks.js";
import { SourceMapResolver } from "../trace/sourcemap.js";
import { deserialize } from "../output/format.js";
import { resolveTarget } from "../commands/resolve.js";

/** Raw V8 CPU sampling profile, as returned by CDP `Profiler.stop` (`.profile`). */
export interface RawCpuProfile {
  nodes: RawProfileNode[];
  startTime: number;
  endTime: number;
  samples: number[];
  timeDeltas: number[];
}

export interface RawProfileNode {
  id: number;
  callFrame: RawCallFrame;
  hitCount?: number;
  children?: number[];
}

export interface RawCallFrame {
  functionName: string;
  scriptId: string;
  url: string;
  /** 0-based, per CDP convention */
  lineNumber: number;
  /** 0-based, per CDP convention */
  columnNumber: number;
}

/** Pseudo-frames V8 injects that are not user functions; bucketed, not ranked. */
const SYSTEM_FRAMES = new Set(["(idle)", "(program)", "(garbage collector)", "(root)"]);

/** Edges below this carry no signal; dropped to keep the model bounded. */
const EDGE_THRESHOLD_MS = 0.05;

/** Joins the two endpoint keys of an edge; frame keys never contain newlines. */
const EDGE_SEPARATOR = "\n";

function frameKey(callFrame: RawCallFrame): string {
  return [callFrame.functionName, callFrame.url, callFrame.lineNumber, callFrame.columnNumber].join(
    " ",
  );
}

/** Trim a pseudo-URL for display: inline data:/blob: payloads can be tens of KB, so keep
 * only a short head. (A base64 ESM module URL would otherwise blow out table widths.) */
function shortPseudoLabel(url: string): string {
  return url.length > 64 ? `${url.slice(0, 48)}…` : url;
}

/**
 * Pseudo-URLs that are not on disk and not fetchable. They must be bucketed by their
 * scheme and never handed to packageForFile, which would fs-walk and mis-blame their
 * cost on a stray package.json (often the tool's own cwd package). Returns the bucket
 * name plus a short display label, or null for a normal local/remote file URL.
 *
 *   blob:                          Blob object URL (e.g. a same-process iframe bundle)
 *   data: / javascript;base64,...  inline ESM data-URI module
 *   wasm://                        a WebAssembly module
 *   v8/, extensions::, chrome*     V8 / browser-internal pseudo-frames
 */
function classifyPseudoUrl(url: string | undefined): { package: string; label: string } | null {
  if (!url) return null;
  if (url.startsWith("blob:")) return { package: "(blob)", label: shortPseudoLabel(url) };
  if (url.startsWith("data:") || url.startsWith("javascript:") || url.startsWith("javascript;")) {
    return { package: "(inline)", label: "(inline)" };
  }
  if (url.startsWith("wasm://")) return { package: "(wasm)", label: shortPseudoLabel(url) };
  if (
    url.startsWith("v8/") ||
    url.startsWith("extensions::") ||
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://")
  ) {
    return { package: "(native)", label: shortPseudoLabel(url) };
  }
  return null;
}

/** The package name for a path inside node_modules; pnpm-safe (uses the LAST segment). */
function packageFromNodeModules(filePath: string): string | null {
  const at = filePath.lastIndexOf("node_modules");
  if (at < 0) return null;
  const after = filePath.slice(at + "node_modules".length).replace(/^[\\/]+/, "");
  const match = after.match(/^((?:@[^\\/]+[\\/])?[^\\/]+)/);
  if (!match) return null;
  const name = match[1].replace(/\\/g, "/");
  // a bare ".../node_modules/.pnpm" with no real package after it carries no signal
  return name === ".pnpm" ? null : name;
}

/**
 * Owning package for a resolved local file: the node_modules package (pnpm-safe), else
 * the nearest package.json `name` (catches monorepo workspace packages like next-yak),
 * else "app". Directory results are cached so each tree is read at most once.
 */
async function packageForFile(
  filePath: string,
  cache: Map<string, string | null>,
): Promise<string> {
  const fromNodeModules = packageFromNodeModules(filePath);
  if (fromNodeModules) return fromNodeModules;

  const visited: string[] = [];
  let dir = path.dirname(filePath);
  for (;;) {
    if (cache.has(dir)) {
      const name = cache.get(dir) ?? null;
      for (const seen of visited) cache.set(seen, name);
      return name ?? "app";
    }
    visited.push(dir);
    let name: string | null = null;
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
      if (typeof manifest.name === "string") name = manifest.name;
    } catch {
      // no package.json in this directory; keep walking up
    }
    if (name) {
      for (const seen of visited) cache.set(seen, name);
      return name;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      for (const seen of visited) cache.set(seen, null);
      return "app";
    }
    dir = parent;
  }
}

interface ResolvedFrame {
  fn: string;
  /** the minified V8 name, when `fn` is the sourcemap-resolved original */
  minified?: string;
  /** "file:line" once resolved, else undefined */
  source?: string;
  /** bare file path (no line) */
  file?: string;
  package: string;
}

/**
 * Resolve a CDP call frame to display name + original source + owning package. CDP
 * line/column are 0-based; convert to 1-based so the existing trace resolvers (which
 * expect the 1-based trace-stack convention) apply unchanged.
 */
async function resolveCallFrame(
  callFrame: RawCallFrame,
  rewriteToLocal: (frame: StackFrame) => StackFrame,
  maps: SourceMapResolver,
  packageCache: Map<string, string | null>,
  root: string,
): Promise<ResolvedFrame> {
  const minifiedName = callFrame.functionName || "(anonymous)";
  const frame: StackFrame = {
    functionName: callFrame.functionName || undefined,
    url: callFrame.url || undefined,
    line: callFrame.url ? callFrame.lineNumber + 1 : undefined,
    column: callFrame.url ? callFrame.columnNumber + 1 : undefined,
  };
  rewriteToLocal(frame);
  await maps.resolveFrame(frame);
  // Prefer the sourcemap's original name (readable, and stable across minified builds so
  // cpu-diff joins correctly); keep the minified name as a secondary label when they differ.
  const fn = frame.originalName ?? minifiedName;
  const minified =
    frame.originalName && frame.originalName !== minifiedName ? minifiedName : undefined;
  const file = frame.source ?? frame.url;
  if (!file) return { fn, minified, package: "(native)" };
  // node builtins (node:internal/..., node:fs, ...) are not on disk and not a dependency
  if (file.startsWith("node:")) return { fn, minified, source: file, file, package: "(node)" };
  // Pseudo-URLs (blob:/data:/inline/wasm/v8/extension) are not on disk and not fetchable:
  // bucket by scheme and never fs-walk them, or packageForFile climbs to a stray package.json
  // and mis-blames their cost on an unrelated package (often wpd's own cwd package). Check the
  // ORIGINAL script URL too, since an inline data: module can carry a sourcemap that fills
  // frame.source and would otherwise hide the scheme.
  const pseudo = classifyPseudoUrl(callFrame.url) ?? classifyPseudoUrl(frame.source);
  if (pseudo) {
    const lineSuffix = frame.line != null ? `:${frame.line}` : "";
    return {
      fn,
      minified,
      source: `${pseudo.label}${lineSuffix}`,
      file: pseudo.label,
      package: pseudo.package,
    };
  }
  const source = `${file}${frame.line != null ? `:${frame.line}` : ""}`;
  // Remote frames aren't on disk, so derive the package from the path string (node_modules
  // deps resolve; app/bundle code falls to "app"). Local resolved sources read package.json.
  if (frame.remote)
    return { fn, minified, source, file, package: packageFromNodeModules(file) ?? "app" };
  const isLocalPath = frame.source != null;
  // Resolve the owning package from the absolute path (reads package.json), then store the
  // path relative to root: smaller model, portable, and a stable cpu-diff join key.
  const owner = isLocalPath ? await packageForFile(file, packageCache) : "app";
  const relFile = relativizeSource(file, root) ?? file;
  return {
    fn,
    minified,
    source: `${relFile}${frame.line != null ? `:${frame.line}` : ""}`,
    file: relFile,
    package: owner,
  };
}

/**
 * Turn a raw CPU profile into a resolved, self-contained model: per-function self/total
 * time, system buckets, and a thresholded call-graph. Sized by function count, not by
 * sample count, so it stays small for complex pages and needs no re-resolution later.
 */
export async function buildCpuModel(
  raw: RawCpuProfile,
  context: {
    profilePath: string;
    meta: RecordingMeta;
    sampleIntervalUs: number;
    /** served-page origin for url->local rewriting (chrome runtime); omit for node */
    serverUrl?: string;
    root: string;
    /** "node" rewrites file:// frames to local paths; default "chrome" */
    runtime?: "chrome" | "node";
  },
): Promise<CpuModel> {
  const byId = new Map<number, RawProfileNode>();
  for (const node of raw.nodes) byId.set(node.id, node);

  // self time per node (attribute each delta to its sample's node)
  const selfUsByNode = new Map<number, number>();
  for (let index = 0; index < raw.samples.length; index++) {
    const nodeId = raw.samples[index];
    const deltaUs = raw.timeDeltas[index] ?? 0;
    selfUsByNode.set(nodeId, (selfUsByNode.get(nodeId) ?? 0) + Math.max(0, deltaUs));
  }

  // roots = nodes that are no one's child
  const childIds = new Set<number>();
  for (const node of raw.nodes) for (const child of node.children ?? []) childIds.add(child);
  const roots = raw.nodes.filter((node) => !childIds.has(node.id)).map((node) => node.id);

  // preorder, then inclusive time bottom-up (reverse preorder => children before parent)
  const preorder: number[] = [];
  const walk = [...roots];
  while (walk.length) {
    const nodeId = walk.pop()!;
    preorder.push(nodeId);
    for (const child of byId.get(nodeId)?.children ?? []) walk.push(child);
  }
  const inclusiveUsByNode = new Map<number, number>();
  for (let index = preorder.length - 1; index >= 0; index--) {
    const nodeId = preorder[index];
    let inclusive = selfUsByNode.get(nodeId) ?? 0;
    for (const child of byId.get(nodeId)?.children ?? [])
      inclusive += inclusiveUsByNode.get(child) ?? 0;
    inclusiveUsByNode.set(nodeId, inclusive);
  }

  // self/total per function key (total is recursion-safe: count a key once per stack)
  const selfUsByKey = new Map<string, number>();
  const callFrameByKey = new Map<string, RawCallFrame>();
  for (const node of raw.nodes) {
    const key = frameKey(node.callFrame);
    callFrameByKey.set(key, node.callFrame);
    selfUsByKey.set(key, (selfUsByKey.get(key) ?? 0) + (selfUsByNode.get(node.id) ?? 0));
  }
  const totalUsByKey = new Map<string, number>();
  const activeDepth = new Map<string, number>();
  const dfs: { nodeId: number; leaving: boolean }[] = [];
  for (let index = roots.length - 1; index >= 0; index--)
    dfs.push({ nodeId: roots[index], leaving: false });
  while (dfs.length) {
    const frame = dfs.pop()!;
    const key = frameKey(byId.get(frame.nodeId)!.callFrame);
    if (frame.leaving) {
      activeDepth.set(key, (activeDepth.get(key) ?? 1) - 1);
      continue;
    }
    if ((activeDepth.get(key) ?? 0) === 0)
      totalUsByKey.set(
        key,
        (totalUsByKey.get(key) ?? 0) + (inclusiveUsByNode.get(frame.nodeId) ?? 0),
      );
    activeDepth.set(key, (activeDepth.get(key) ?? 0) + 1);
    dfs.push({ nodeId: frame.nodeId, leaving: true });
    const children = byId.get(frame.nodeId)?.children ?? [];
    for (let childIndex = children.length - 1; childIndex >= 0; childIndex--)
      dfs.push({ nodeId: children[childIndex], leaving: false });
  }

  // resolve each unique frame (sourcemap + local path) once
  const rewriteToLocal =
    context.runtime === "node"
      ? makeNodeSourceResolver()
      : makeSourceResolver(context.serverUrl ?? "", context.root);
  const maps = new SourceMapResolver();
  const resolvedByKey = new Map<string, ResolvedFrame>();
  const packageCache = new Map<string, string | null>();
  for (const [key, callFrame] of callFrameByKey)
    resolvedByKey.set(
      key,
      await resolveCallFrame(callFrame, rewriteToLocal, maps, packageCache, context.root),
    );

  // system buckets vs rankable user functions
  const systemMs = (name: string) =>
    [...callFrameByKey].reduce(
      (sum, [key, callFrame]) =>
        callFrame.functionName === name && !callFrame.url
          ? sum + (selfUsByKey.get(key) ?? 0) / 1000
          : sum,
      0,
    );
  const system = {
    idleMs: systemMs("(idle)"),
    gcMs: systemMs("(garbage collector)"),
    programMs: systemMs("(program)"),
  };
  const sampledUs = [...selfUsByNode.values()].reduce((sum, value) => sum + value, 0);
  const idleUs = system.idleMs * 1000;
  const scriptingMs = Math.max(0, (sampledUs - idleUs) / 1000);

  const ranked = [...callFrameByKey.keys()]
    .filter((key) => {
      const callFrame = callFrameByKey.get(key)!;
      // exclude V8 pseudo-frames and puppeteer's own harness frames (not user code)
      if (SYSTEM_FRAMES.has(callFrame.functionName) && !callFrame.url) return false;
      return !isToolFrameUrl(callFrame.url);
    })
    .map((key) => {
      const resolved = resolvedByKey.get(key)!;
      return {
        key,
        fn: resolved.fn,
        minified: resolved.minified,
        source: resolved.source,
        file: resolved.file,
        package: resolved.package,
        selfMs: (selfUsByKey.get(key) ?? 0) / 1000,
        totalMs: (totalUsByKey.get(key) ?? 0) / 1000,
      };
    })
    .sort((left, right) => right.selfMs - left.selfMs || left.key.localeCompare(right.key));

  const idByKey = new Map<string, number>();
  const functions: CpuFunction[] = ranked.map((entry, index) => {
    idByKey.set(entry.key, index);
    return {
      id: index,
      fn: entry.fn,
      minified: entry.minified,
      source: entry.source,
      file: entry.file,
      package: entry.package,
      selfMs: entry.selfMs,
      selfPct: scriptingMs > 0 ? (entry.selfMs / scriptingMs) * 100 : 0,
      totalMs: entry.totalMs,
    };
  });

  // call-graph edges: parent function -> child function, child subtree inclusive time
  const edgeUs = new Map<string, number>();
  for (const node of raw.nodes) {
    const parentKey = frameKey(node.callFrame);
    for (const childId of node.children ?? []) {
      const childKey = frameKey(byId.get(childId)!.callFrame);
      const edgeId = `${parentKey}${EDGE_SEPARATOR}${childKey}`;
      edgeUs.set(edgeId, (edgeUs.get(edgeId) ?? 0) + (inclusiveUsByNode.get(childId) ?? 0));
    }
  }
  const edges: CpuEdge[] = [];
  for (const [edgeId, microseconds] of edgeUs) {
    const separatorAt = edgeId.indexOf(EDGE_SEPARATOR);
    const caller = idByKey.get(edgeId.slice(0, separatorAt));
    const callee = idByKey.get(edgeId.slice(separatorAt + 1));
    const ms = microseconds / 1000;
    if (caller != null && callee != null && ms >= EDGE_THRESHOLD_MS)
      edges.push({ caller, callee, ms });
  }

  return {
    profile: context.profilePath,
    meta: context.meta,
    sampleCount: raw.samples.length,
    sampleIntervalUs: context.sampleIntervalUs,
    totalMs: raw.timeDeltas.reduce((sum, value) => sum + Math.max(0, value), 0) / 1000,
    scriptingMs,
    system,
    functions,
    edges,
  };
}

/** Self time bucketed by a per-function key (package or file), descending. */
function rollup(model: CpuModel, keyOf: (fn: CpuFunction) => string): CpuGroupStat[] {
  const byKey = new Map<string, { selfMs: number; functions: number }>();
  for (const fn of model.functions) {
    const key = keyOf(fn);
    const entry = byKey.get(key) ?? { selfMs: 0, functions: 0 };
    entry.selfMs += fn.selfMs;
    entry.functions += 1;
    byKey.set(key, entry);
  }
  return [...byKey.entries()]
    .map(([key, entry]) => ({
      key,
      selfMs: entry.selfMs,
      selfPct: model.scriptingMs > 0 ? (entry.selfMs / model.scriptingMs) * 100 : 0,
      functions: entry.functions,
    }))
    .sort((left, right) => right.selfMs - left.selfMs);
}

/** Self time by owning npm/workspace package (the headline rollup). */
export function packageRollup(model: CpuModel): CpuGroupStat[] {
  return rollup(model, (fn) => fn.package);
}

/** Self time by source file. */
export function fileRollup(model: CpuModel): CpuGroupStat[] {
  return rollup(model, (fn) => fn.file ?? "(native)");
}

/** A stable join key for comparing the same function across two runs (cpu-diff). Joins on the
 * bare file path (not `source`, which carries `:line`): an edit that shifts a hot function down
 * a few lines must not split it into a phantom improvement (old key) + regression (new key). */
export function functionJoinKey(fn: CpuFunction): string {
  return `${fn.fn} ${fn.file ?? fn.package}`;
}

/** Last `segments` path components, for compact table display. */
export function tailPath(filePath: string, segments = 2): string {
  const parts = filePath.split(/[\\/]+/).filter(Boolean);
  return parts.length <= segments ? filePath : parts.slice(-segments).join("/");
}

/**
 * Compact "dir/file:line" for tables (the full absolute path is kept in the model and
 * shown by `query frame`). Pairs with the package column, which carries the owner.
 */
export function shortSource(
  file: string | undefined,
  source: string | undefined,
  segments = 2,
): string {
  if (!file) return source ?? "";
  const line = source && source.length > file.length ? source.slice(file.length + 1) : "";
  const tail = tailPath(file, segments);
  return line ? `${tail}:${line}` : tail;
}

/**
 * Load a resolved CPU model. Accepts the `.cpu.json` directly, `latest`, or (as a
 * convenience) a recording path whose sibling `.cpu.json` is loaded instead.
 */
export async function loadCpuModel(file: string): Promise<CpuModel> {
  const abs = await resolveTarget(file, "cpu-model");
  const parsed = deserialize(await fs.readFile(abs, "utf8"), path.extname(abs).toLowerCase());
  if (parsed && Array.isArray((parsed as CpuModel).functions)) return parsed as CpuModel;
  // a recording path was likely passed; try its sibling cpu model. `--out runs/a` writes the
  // recording to an extension-less path, so default the sibling to `.json` when there is no ext
  // (slicing by a zero-length ext would otherwise blank the whole base path).
  const ext = path.extname(abs);
  const base = ext ? abs.slice(0, -ext.length) : abs;
  const sibling = `${base}.cpu${ext || ".json"}`;
  try {
    const fallback = deserialize(
      await fs.readFile(sibling, "utf8"),
      path.extname(sibling).toLowerCase(),
    );
    if (fallback && Array.isArray((fallback as CpuModel).functions)) return fallback as CpuModel;
  } catch {
    // fall through to the error below
  }
  throw new Error(
    `${file} is not a CPU model. Pass the .cpu.json, or use 'latest' after recording with --cpu-profile.`,
  );
}
