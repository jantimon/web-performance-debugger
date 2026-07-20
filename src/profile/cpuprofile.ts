import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import type {
  CpuBreakdown,
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
import type { GeckoSlice } from "./gecko.js";
import { computeGeckoCpuBreakdown } from "./gecko-breakdown.js";
import { usToMs, msToUs } from "../model/time.js";
import { reconcileResidual } from "../model/reconcile.js";
import { deserialize } from "../output/format.js";
import { assertSchemaVersion } from "../model/artifact.js";
import { resolveTarget } from "../commands/resolve.js";

/** Raw V8 CPU sampling profile, as returned by CDP `Profiler.stop` (`.profile`). */
export interface RawCpuProfile {
  nodes: RawProfileNode[];
  startTime: number;
  endTime: number;
  samples: number[];
  timeDeltas: number[];
  /**
   * Firefox (js,cpu) only: per-sample breakdown data the Gecko converter attaches, parallel to
   * `samples`/`timeDeltas`. Absent on chrome/node (their breakdown reads node classification) and on
   * firefox dumps with an empty `threadCPUDelta` column (no honest idle signal, so no breakdown).
   */
  gecko?: { sampleSlices: GeckoSlice[] };
  /**
   * Trace-sourced (--breakdown chrome) only: the absolute trace-clock timestamp (us) of each sample,
   * parallel to `samples`. The profile merges the per-process streams a cross-document navigation
   * splits, so `startTime + Σ timeDeltas` no longer reconstructs a sample's real clock position; the
   * per-span windowing reads these directly. Absent on the CDP/node/gecko single-stream profiles,
   * where the cumulative reconstruction is exact, and stripped before the raw `.cpuprofile` is written
   * (it is not part of the DevTools format).
   */
  sampleTimestampsUs?: number[];
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

/**
 * A rankable user function, i.e. one that earns an id in `CpuModel.functions[]`. Excludes V8's
 * pseudo-frames ((idle)/(program)/(garbage collector)/(root)) and the tool's own harness frames. The
 * ONE predicate the ranked model and the per-span `functionIdByNode` join both use, so they assign
 * identical ids and a per-span sample cannot land on a phantom function.
 */
function isRankableFrame(callFrame: RawCallFrame): boolean {
  if (SYSTEM_FRAMES.has(callFrame.functionName) && !callFrame.url) return false;
  return !isToolFrameUrl(callFrame.url);
}

/**
 * The one ranking both CpuModel.functions[] and the per-span hot refs share: rankable frames by
 * self-time descending, key as the tie-break. Function ids ARE positions in this order, so any
 * consumer deriving ids must call this rather than re-sorting.
 */
function rankedFrameKeys(
  callFrameByKey: Map<string, RawCallFrame>,
  selfUsByKey: Map<string, number>,
): string[] {
  return [...callFrameByKey.keys()]
    .filter((key) => isRankableFrame(callFrameByKey.get(key)!))
    .sort(
      (left, right) =>
        (selfUsByKey.get(right) ?? 0) - (selfUsByKey.get(left) ?? 0) || left.localeCompare(right),
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
  const webpack = classifyWebpackRuntime(url);
  if (webpack) return webpack;
  return null;
}

/**
 * Webpack's own module-loader RUNTIME (the `webpack/bootstrap` entry, the `webpack/runtime/*`
 * helpers, and the older `(webpack)/buildin/*` polyfills) has no real source on disk: a sourcemap's
 * `sources` array names it with those synthetic paths, optionally behind a `webpack://host/` or
 * `webpack-internal://` scheme. Left alone it has `frame.source` set but is in no node_modules, so
 * resolveCallFrame calls it `app` and inflates the user's own cost by tens of ms (~20% on a real
 * production boot). Bucket it as `(webpack)`, a not-a-real-package bucket like the others.
 *
 * A GENUINE mapped module does NOT match: `webpack://app/./src/index.js` cleans to `src/index.js`,
 * `webpack://app/./node_modules/react/index.js` to `node_modules/react/index.js` -- neither begins
 * with the runtime markers, so both resolve to their real owner. Accepts both the raw scheme URL and
 * the already-cleaned source (cleanRemoteSource strips the scheme+host), so it matches at either call
 * site.
 */
function classifyWebpackRuntime(url: string): { package: string; label: string } | null {
  const withoutScheme = url.replace(/^webpack(-internal)?:\/\/[^/]*\//i, "").replace(/^\.?\//, "");
  if (
    /^webpack\/(bootstrap|runtime)(\/|\s|$)/.test(withoutScheme) ||
    withoutScheme.startsWith("(webpack)/")
  )
    return { package: "(webpack)", label: shortPseudoLabel(withoutScheme) };
  return null;
}

/**
 * Default sampler interval for EVERY lane (CDP and node's inspector). One definition: a lane that
 * declares its own can drift silently, since nothing type-checks two constants into agreement. A
 * unit test asserts no lane redeclares it. See docs/dev/cpu-profiling.md for why 200.
 */
export const DEFAULT_CPU_INTERVAL_US = 200;

/**
 * The standard `.cpuprofile` shape for DevTools/Speedscope from a trace-sourced (--breakdown) profile.
 * A single-stream profile is returned unchanged (it already matches CDP). A profile that merged the
 * per-process streams a navigation splits carries an extra `sampleTimestampsUs` (the absolute
 * per-sample clock) and two structural quirks DevTools cannot read: more than one `(root)` (DevTools
 * assumes a single-rooted tree), and per-sample `timeDeltas` that do not encode the cross-process gap
 * (they are the model's per-sample self-time, not a continuous timeline). Fix both for the on-disk
 * file only: recompute the deltas from the absolute timestamps so the timeline is faithful, and parent
 * the process roots under one synthetic super-root. wpd's own model keeps the multi-root form and the
 * per-sample deltas (it windows by `sampleTimestampsUs` directly), so nothing here touches the numbers.
 */
export function toDevtoolsCpuProfile(raw: RawCpuProfile): RawCpuProfile {
  const timestamps = raw.sampleTimestampsUs;
  if (timestamps == null) return raw;
  const timeDeltas = timestamps.map((timestamp, index) =>
    index === 0 ? 0 : timestamp - timestamps[index - 1],
  );
  return {
    nodes: singleRootedNodes(raw.nodes),
    startTime: timestamps[0] ?? raw.startTime,
    endTime: timestamps[timestamps.length - 1] ?? raw.endTime,
    samples: raw.samples,
    timeDeltas,
  };
}

/** Parent every root (a node no one is a child of) under one synthetic `(root)` super-root, so the
 * DevTools-format tree is single-rooted. A profile that already has one root is returned as-is. */
function singleRootedNodes(nodes: RawProfileNode[]): RawProfileNode[] {
  const childIds = new Set<number>();
  for (const node of nodes) for (const childId of node.children ?? []) childIds.add(childId);
  const rootIds = nodes.filter((node) => !childIds.has(node.id)).map((node) => node.id);
  if (rootIds.length <= 1) return nodes;
  let maxId = 0;
  for (const node of nodes) if (node.id > maxId) maxId = node.id;
  const superRoot: RawProfileNode = {
    id: maxId + 1,
    callFrame: { functionName: "(root)", scriptId: "0", url: "", lineNumber: -1, columnNumber: -1 },
    children: rootIds,
  };
  return [superRoot, ...nodes];
}

/**
 * Ephemeral-port range: a `listen(0)` server (a dev or test server, e.g. the host page a
 * `--bench --url` run points at) is assigned a port the OS re-picks every run, so it carries no
 * cross-run identity. An unmapped frame served from `http://127.0.0.1:54927/...` must bucket by host
 * alone or the same code splits across a new `(127.0.0.1:PORT)` bucket per run. A registered port
 * (`:3000`, `:8080`, `:443`) names a service the user runs on purpose and stays in the bucket.
 *
 * OS ephemeral ranges vary and the floor is deliberately the widest common one, not the IANA
 * dynamic/private start (49152): Linux `listen(0)` defaults to 32768-60999, so anchoring at 49152
 * would keep the port for the low ~58% of Linux-assigned ports and leak exactly the bench frames
 * this bucketing exists to stabilize. 32768 covers Linux's default as well as the 49152-65535 range
 * macOS/BSD/Windows use. Trade: a deliberate service on a 32768-49151 port loses its port from an
 * unmapped bucket, accepted for the same reason the range exists.
 */
const EPHEMERAL_PORT_MIN = 32768;
const EPHEMERAL_PORT_MAX = 65535;

/**
 * Bucket for a remote script whose sourcemap did not resolve: we know its origin and nothing
 * else. Blaming it on "app" would be a guess, and a wrong one for every third-party script
 * (analytics, CDN widgets), whose cost would land in the user's own bucket. Parenthesized to
 * match the other "not a real package" buckets ((blob)/(inline)/(wasm)/(node)/(native)).
 *
 * The port is dropped from the key when it is in the ephemeral range: an OS-assigned dev/test-server
 * port is a per-run accident, and keeping it would give the same unmapped code a fresh bucket every
 * run and split every cross-run cpu-diff / functionJoinKey join. The trade: two different
 * ephemeral-port origins on one host merge into a single bucket, and an ephemeral-port remote host
 * loses its port; accepted because unmapped-frame joins must survive a `listen(0)` re-pick.
 */
function unmappedOriginBucket(url: string | undefined): string {
  if (!url) return "(unmapped)";
  try {
    const parsed = new URL(url);
    const port = Number(parsed.port);
    const ephemeral =
      parsed.port !== "" && port >= EPHEMERAL_PORT_MIN && port <= EPHEMERAL_PORT_MAX;
    return `(${ephemeral ? parsed.hostname : parsed.host})`;
  } catch {
    return "(unmapped)";
  }
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
 * Bucket for a frame whose sourcemap named an original source that is NOT on disk (a dependency
 * built from a workspace/source checkout, or a stale map). The path is the map's claim, not a real
 * file, so it cannot be fs-walked to a package.json. Calling it "app" blames a dependency's cost on
 * the user's own code; instead name the phantom's containing directory so the bucket points at the
 * broken map. Parenthesized to match the other "not a real package" buckets ((unmapped)/(served)/...).
 */
function offDiskSourceBucket(filePath: string): string {
  const dir = path.basename(path.dirname(filePath));
  return dir && dir !== "." ? `(unmapped: ${dir})` : "(unmapped)";
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

/**
 * Attribution for a frame still pointing at wpd's OWN served origin (bench mode serves the user's
 * module tree over http) whose source did not land on disk. Returns null unless `url` is an EXACT
 * origin match against the served origin, so a genuinely remote host is left to the branches below.
 *
 * The server roots at the project root, so map the served pathname back to the local file and let
 * `packageForFile` attribute it like any on-disk source (the real npm/workspace package or the real
 * relative file). Only when the pathname names no existing local file fall back to the stable
 * literal `(served)` bucket, rather than fs-walking the missing path up to a stray package.json.
 */
async function attributeServedOrigin(
  url: string | undefined,
  servedOrigin: string,
  root: string,
  cache: Map<string, string | null>,
): Promise<{ package: string; file?: string } | null> {
  if (!url || !servedOrigin) return null;
  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(servedOrigin).origin;
  } catch {
    return null;
  }
  let pathname: string;
  try {
    const parsed = new URL(url);
    if (parsed.origin !== expectedOrigin) return null;
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  const localPath = path.join(root, pathname.replace(/^[\\/]+/, ""));
  const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;
  // A pathname that resolves to root itself (bare `/` or empty), escapes root, or names no on-disk
  // file cannot be honestly attributed to a local package; `(served)` is the stable answer rather
  // than a guess. root is included on purpose: `packageForFile(root)` walks UPWARD to an ancestor
  // package.json, the stray walk this fallback exists to avoid.
  if (!localPath.startsWith(rootPrefix) || !existsSync(localPath)) {
    return { package: "(served)" };
  }
  return { package: await packageForFile(localPath, cache), file: localPath };
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
  /**
   * True only when `package` came from `unmappedOriginBucket`, i.e. we could NOT work out whose
   * code this is and fell back to its origin. Set at the point of that decision rather than
   * inferred later from the package string: `(cdn.example.com)` is unmapped but `(native)` and
   * `(node)` are not, and telling those apart by pattern breaks on a dotless host like
   * `(localhost)`. This is the only honest signal for "the package rollup is lying".
   */
  unmapped?: boolean;
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
  servedOrigin: string,
): Promise<ResolvedFrame> {
  const minifiedName = callFrame.functionName || "(anonymous)";
  // CDP callFrame line/column are 0-based; +1 makes them 1-based (the trace-stack convention). V8
  // reports a positionless frame (a native/builtin call that still carries a script url) as
  // lineNumber/columnNumber -1, which would shift to 0 -- an invalid line that makes the sourcemap
  // lookup throw. Treat a negative source position as "no position" (undefined) instead.
  const hasPosition = callFrame.url != null && callFrame.url !== "" && callFrame.lineNumber >= 0;
  const frame: StackFrame = {
    functionName: callFrame.functionName || undefined,
    url: callFrame.url || undefined,
    line: hasPosition ? callFrame.lineNumber + 1 : undefined,
    column: hasPosition ? callFrame.columnNumber + 1 : undefined,
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
  // A frame from wpd's OWN served origin (bench mode serves the module tree over an ephemeral
  // localhost port) whose source is not on disk: the sourcemap mapped the served bundle to an
  // original source that is not on disk (a bundle built elsewhere, or a stale map). Left alone,
  // `packageForFile` fs-walks that missing path up to whatever stray package.json it first hits and
  // mis-blames the cost there. Instead attribute it to the local file the server actually served
  // (the real npm/workspace package), or the stable literal `(served)` bucket when the served
  // pathname names no on-disk file. A frame that DID resolve to an existing source (the common case:
  // makeSourceResolver -> the served bundle on disk, or a mapped original source) is already the
  // best, stablest answer and is left to the branches below.
  const sourceExists =
    frame.source != null && path.isAbsolute(frame.source) && existsSync(frame.source);
  if (!sourceExists) {
    const served = await attributeServedOrigin(frame.url, servedOrigin, root, packageCache);
    if (served) {
      const lineSuffix = frame.line != null ? `:${frame.line}` : "";
      if (served.file) {
        const relServed = relativizeSource(served.file, root) ?? served.file;
        return {
          fn,
          minified,
          source: `${relServed}${lineSuffix}`,
          file: relServed,
          package: served.package,
        };
      }
      return {
        fn,
        minified,
        source: `(served)${lineSuffix}`,
        file: "(served)",
        package: "(served)",
      };
    }
  }
  const source = `${file}${frame.line != null ? `:${frame.line}` : ""}`;
  // Remote frames aren't on disk, so derive the package from the path string. Three cases, and
  // the difference between the last two is the whole point: frame.source is set only when the
  // sourcemap resolved, so an unmapped frame is still pointing at the bundle url and we do NOT
  // know whose code it is. Calling that "app" silently blames every unmapped third-party script
  // on the user's own bundle.
  if (frame.remote) {
    const dependency = packageFromNodeModules(file);
    const owner = dependency ?? (frame.source != null ? "app" : unmappedOriginBucket(frame.url));
    return {
      fn,
      minified,
      source,
      file,
      package: owner,
      unmapped: dependency == null && frame.source == null,
    };
  }
  const isLocalPath = frame.source != null;
  const relFile = relativizeSource(file, root) ?? file;
  const lineSuffix = frame.line != null ? `:${frame.line}` : "";
  // Not-on-disk and not flagged remote means the frame was never rewritten to a local path
  // (e.g. --target node handed an http url): unknown owner, so bucket it rather than guess "app".
  if (!isLocalPath) {
    return {
      fn,
      minified,
      source: `${relFile}${lineSuffix}`,
      file: relFile,
      package: unmappedOriginBucket(frame.url),
      unmapped: true,
    };
  }
  // A sourcemap remapped this frame (frame.bundled is set only then) to an absolute source that is
  // NOT on disk: the map named an original source the recorder does not have (a dependency built
  // from a workspace/source checkout, or a stale map). fs-walking that phantom path up to the
  // nearest package.json lands on whatever sits above it -- usually the user's own root -- and blames
  // a dependency's cost on "app". Instead derive the owner from the path string: the node_modules
  // package the phantom source or its original bundle url names (the code really is that dependency),
  // else an honest off-disk bucket that names the phantom directory, never "app". A frame that was
  // NEVER remapped points at its own url and is the app's own file even when that file is absent, so
  // it is left to packageForFile. The off-disk bucket is not counted in `unmapped`: that flag drives
  // the map-LOAD-health warning (origin-bucketed frames from a failed map), and this map loaded fine;
  // the parenthesized bucket name is the rollup's own honest "owner unknown" signal.
  if (frame.bundled != null && path.isAbsolute(file) && !sourceExists) {
    const dependency = packageFromNodeModules(file) ?? packageFromNodeModules(frame.url ?? "");
    return {
      fn,
      minified,
      source: `${relFile}${lineSuffix}`,
      file: relFile,
      package: dependency ?? offDiskSourceBucket(file),
    };
  }
  // Resolve the owning package from the on-disk path (reads package.json), then store the path
  // relative to root: smaller model, portable, and a stable cpu-diff join key.
  return {
    fn,
    minified,
    source: `${relFile}${lineSuffix}`,
    file: relFile,
    package: await packageForFile(file, packageCache),
  };
}

/**
 * Reconciling `js · browser · gc · idle` decomposition of the profile's own sampled window.
 *
 * Built from `samples[]` + `timeDeltas[]` (via `selfUsByNode`, which already attributed each delta
 * to its sample's node), NOT from `selfMs` aggregates: every node classifies into exactly one slice
 * and every delta belongs to a node, so `js + browser + gc + idle === wallMs` EXACTLY with zero
 * residual. `wallMs` is the sum of the profile's time deltas (which equals `CpuModel.totalMs`), not
 * an external wall: `endTime - startTime` carries a small tail after the last sample that belongs to
 * no delta, which would break the closure.
 *
 * Classification of a node:
 *  - (idle)              -> idle
 *  - (garbage collector) -> gc
 *  - (program)/(root), or a tool harness frame -> browser (engine/runtime work with the profiled
 *    JS not on the stack; left unsplit)
 *  - everything else     -> js, bucketed by the SAME resolved package as `functions`/packageRollup,
 *    so `byPackage` matches `query cpu --by package` and sums to `js.ms`.
 */
function computeBreakdown(
  nodes: RawProfileNode[],
  selfUsByNode: Map<number, number>,
  resolvedByKey: Map<string, ResolvedFrame>,
  totalMs: number,
): CpuBreakdown {
  let idleUs = 0;
  let gcUs = 0;
  let browserUs = 0;
  let jsUs = 0;
  const byPackageUs = new Map<string, number>();
  for (const node of nodes) {
    const selfUs = selfUsByNode.get(node.id) ?? 0;
    if (selfUs === 0) continue;
    const { functionName, url } = node.callFrame;
    if (!url && functionName === "(idle)") {
      idleUs += selfUs;
    } else if (!url && functionName === "(garbage collector)") {
      gcUs += selfUs;
    } else if (!url && (functionName === "(program)" || functionName === "(root)")) {
      browserUs += selfUs;
    } else if (isToolFrameUrl(url)) {
      browserUs += selfUs;
    } else {
      // resolvedByKey is keyed by frameKey over these same raw.nodes, so this lookup always hits;
      // fall back to jsUs staying unattributed rather than inventing a "(native)" bucket.
      const owner = resolvedByKey.get(frameKey(node.callFrame))?.package;
      if (owner == null) continue;
      jsUs += selfUs;
      byPackageUs.set(owner, (byPackageUs.get(owner) ?? 0) + selfUs);
    }
  }
  const byPackage: Record<string, number> = {};
  for (const [owner, microseconds] of [...byPackageUs].sort((left, right) => right[1] - left[1]))
    byPackage[owner] = usToMs(microseconds);
  const breakdown: CpuBreakdown = {
    wallMs: totalMs,
    slices: {
      js: { ms: usToMs(jsUs), byPackage },
      browser: { ms: usToMs(browserUs) },
      gc: { ms: usToMs(gcUs) },
      idle: { ms: usToMs(idleUs) },
    },
  };
  // Every classified node adds its selfUs to exactly one slice, so the four sum to totalMs by
  // construction. The one leak is a node whose owner resolves to null (the `continue` above): its
  // time belongs to no slice. The residual surfaces that instead of letting the bar quietly fall
  // short of wall; same epsilon + escape valve as the seven-slice breakdown.
  const sliceSum =
    breakdown.slices.js.ms +
    breakdown.slices.browser.ms +
    breakdown.slices.gc.ms +
    breakdown.slices.idle.ms;
  const residual = reconcileResidual(breakdown.wallMs, sliceSum);
  if (residual !== undefined) breakdown.residualMs = residual;
  return breakdown;
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
    /** share one resolver (cache + diagnostics) with the run's stack resolution; omit for a fresh one */
    maps?: SourceMapResolver;
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
  const maps = context.maps ?? new SourceMapResolver();
  const resolvedByKey = new Map<string, ResolvedFrame>();
  const packageCache = new Map<string, string | null>();
  // Fetch the distinct remote script maps concurrently first, so the serial resolve below reads the
  // cache instead of fetching one script at a time (minutes on a heavy --url site). Only genuinely
  // remote urls (not the served origin, which resolves to local paths) are warmed.
  const servedOrigin = context.serverUrl ?? "";
  await maps.warm(
    [...callFrameByKey.values()]
      .map((callFrame) => callFrame.url)
      .filter(
        (url): url is string =>
          url != null &&
          url.startsWith("http") &&
          (servedOrigin === "" || !url.startsWith(servedOrigin)),
      ),
  );
  for (const [key, callFrame] of callFrameByKey)
    resolvedByKey.set(
      key,
      await resolveCallFrame(
        callFrame,
        rewriteToLocal,
        maps,
        packageCache,
        context.root,
        context.serverUrl ?? "",
      ),
    );
  // Frames whose owner we could not determine, i.e. what a failed sourcemap actually costs you.
  // Surfaced on the model so `record` can warn about a broken package rollup only when it really
  // is broken: a missing sourcemap for plain unbundled source is a non-event, because those frames
  // resolve straight to their local path with no map involved.
  const unmappedFrames = [...resolvedByKey.values()].filter((frame) => frame.unmapped).length;

  // system buckets vs rankable user functions
  const systemMs = (name: string) =>
    [...callFrameByKey].reduce(
      (sum, [key, callFrame]) =>
        callFrame.functionName === name && !callFrame.url
          ? sum + usToMs(selfUsByKey.get(key) ?? 0)
          : sum,
      0,
    );
  const system = {
    idleMs: systemMs("(idle)"),
    gcMs: systemMs("(garbage collector)"),
    programMs: systemMs("(program)"),
  };
  const sampledUs = [...selfUsByNode.values()].reduce((sum, value) => sum + value, 0);
  const idleUs = msToUs(system.idleMs);
  const scriptingMs = Math.max(0, usToMs(sampledUs - idleUs));

  const ranked = rankedFrameKeys(callFrameByKey, selfUsByKey).map((key) => {
    const resolved = resolvedByKey.get(key)!;
    return {
      key,
      fn: resolved.fn,
      minified: resolved.minified,
      source: resolved.source,
      file: resolved.file,
      package: resolved.package,
      selfMs: usToMs(selfUsByKey.get(key) ?? 0),
      totalMs: usToMs(totalUsByKey.get(key) ?? 0),
    };
  });

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
    const ms = usToMs(microseconds);
    if (caller != null && callee != null && ms >= EDGE_THRESHOLD_MS)
      edges.push({ caller, callee, ms });
  }

  const totalMs = usToMs(raw.timeDeltas.reduce((sum, value) => sum + Math.max(0, value), 0));
  // Firefox reconciles too, but off a different axis: idle is the per-sample CPU-usage signal
  // (threadCPUDelta ~0 == descheduled/waiting) and style/layout come from the per-sample
  // Layout-category frame, both carried on `raw.gecko` when the `cpu` profiler feature populated the
  // column. Without that signal (js-only or an older dump) idle cannot be told from (program), so no
  // breakdown is emitted rather than a fabricated one. Chrome/node classify V8's synthetic frames.
  let breakdown: CpuBreakdown | undefined;
  if (context.meta.browser === "firefox") {
    if (raw.gecko) {
      const packageByNode = new Map<number, string | null>();
      for (const node of raw.nodes)
        packageByNode.set(node.id, resolvedByKey.get(frameKey(node.callFrame))?.package ?? null);
      breakdown = computeGeckoCpuBreakdown(raw, packageByNode, totalMs);
    }
  } else {
    breakdown = computeBreakdown(raw.nodes, selfUsByNode, resolvedByKey, totalMs);
  }

  return {
    profile: context.profilePath,
    meta: context.meta,
    sampleCount: raw.samples.length,
    sampleIntervalUs: context.sampleIntervalUs,
    totalMs,
    scriptingMs,
    system,
    breakdown,
    functions,
    edges,
    unmappedFrames,
  };
}

/**
 * Owning package per cpuprofile node id, for the --breakdown js-slice subdivision. Reuses the exact
 * resolution the CPU model uses (`resolveCallFrame` + the shared sourcemap resolver + package
 * walk), so a sample's package matches `query cpu --by package`. System pseudo-frames
 * ((idle)/(garbage collector)/(program)/(root)) and the tool's own harness frames map to null: they
 * are never a real owner, so a stray sample on one must not skew the js-by-package split.
 *
 * Deliberately re-walks call-frame resolution here: the CpuModel exposes no node-id-to-package map,
 * and the shared resolver cache means this re-walk fetches no script or map twice.
 */
export async function packagesByProfileNode(
  raw: RawCpuProfile,
  context: {
    serverUrl?: string;
    root: string;
    runtime?: "chrome" | "node";
    maps?: SourceMapResolver;
  },
): Promise<Map<number, string | null>> {
  const rewriteToLocal =
    context.runtime === "node"
      ? makeNodeSourceResolver()
      : makeSourceResolver(context.serverUrl ?? "", context.root);
  const maps = context.maps ?? new SourceMapResolver();
  const packageCache = new Map<string, string | null>();
  const packageByKey = new Map<string, string | null>();
  const byNode = new Map<number, string | null>();
  for (const node of raw.nodes) {
    if (!isRankableFrame(node.callFrame)) {
      byNode.set(node.id, null);
      continue;
    }
    const key = frameKey(node.callFrame);
    if (!packageByKey.has(key)) {
      const resolved = await resolveCallFrame(
        node.callFrame,
        rewriteToLocal,
        maps,
        packageCache,
        context.root,
        context.serverUrl ?? "",
      );
      packageByKey.set(key, resolved.package);
    }
    byNode.set(node.id, packageByKey.get(key) ?? null);
  }
  return byNode;
}

/**
 * Owning `CpuModel.functions[]` id per cpuprofile node, for the per-span hot tally. The id is the
 * node's frame rank by self time, computed the SAME way `buildCpuModel` ranks (`isRankableFrame`
 * filter, then self-time descending with a frameKey tiebreak), so a per-span sample joins to the
 * EXACT function `query cpu`/`query frame` show. A node whose frame is not a rankable user function
 * (V8 pseudo-frame, tool harness) has no id: it is absent from the map, never a phantom.
 *
 * Pure over `raw`: the rank depends only on sample self-time and the frame key, not on source
 * resolution, so this needs neither the sourcemap resolver nor the built model. It re-derives
 * self-time per key rather than sharing `buildCpuModel`'s (both are cheap node walks over the same
 * `raw`), so the join stays a standalone function the record-time projection loop can call directly.
 */
export function functionIdByNode(raw: RawCpuProfile): Map<number, number> {
  const selfUsByNode = new Map<number, number>();
  for (let index = 0; index < raw.samples.length; index++) {
    const nodeId = raw.samples[index];
    selfUsByNode.set(
      nodeId,
      (selfUsByNode.get(nodeId) ?? 0) + Math.max(0, raw.timeDeltas[index] ?? 0),
    );
  }
  const selfUsByKey = new Map<string, number>();
  const callFrameByKey = new Map<string, RawCallFrame>();
  for (const node of raw.nodes) {
    const key = frameKey(node.callFrame);
    callFrameByKey.set(key, node.callFrame);
    selfUsByKey.set(key, (selfUsByKey.get(key) ?? 0) + (selfUsByNode.get(node.id) ?? 0));
  }
  const idByKey = new Map<string, number>();
  rankedFrameKeys(callFrameByKey, selfUsByKey).forEach((key, index) => idByKey.set(key, index));
  const byNode = new Map<number, number>();
  for (const node of raw.nodes) {
    const id = idByKey.get(frameKey(node.callFrame));
    if (id != null) byNode.set(node.id, id);
  }
  return byNode;
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

/** Longest path tail a compacted remote URL keeps before it is ellipsized (its origin is separate). */
const REMOTE_TAIL_MAX = 40;

/**
 * Compact an unmapped remote script URL for a table cell: origin + the last path segment(s), with the
 * query string and hash dropped. An unmapped third-party frame's `file` is its full URL, which can run
 * hundreds of chars (a config endpoint with a long query string), sizing the source column to a wall
 * of dashes. The origin is kept whole -- it is the attribution signal such a frame buckets by -- and
 * the path tail is capped so one long segment cannot blow the column out either.
 */
export function shortRemoteUrl(url: string, segments = 2): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const pathParts = parsed.pathname.split("/").filter(Boolean);
  let tail = pathParts.slice(-segments).join("/");
  if (tail.length > REMOTE_TAIL_MAX) tail = `${tail.slice(0, REMOTE_TAIL_MAX)}…`;
  if (!tail) return parsed.origin;
  const elided = pathParts.length > segments ? "…/" : "";
  return `${parsed.origin}/${elided}${tail}`;
}

const REMOTE_URL = /^https?:\/\//i;

/**
 * Compact "dir/file:line" for tables (the full absolute path is kept in the model and
 * shown by `query frame`). Pairs with the package column, which carries the owner. A remote URL
 * (an unmapped third-party frame) is compacted to origin + truncated path via `shortRemoteUrl`, so a
 * long config URL does not size the column to hundreds of chars.
 */
export function shortSource(
  file: string | undefined,
  source: string | undefined,
  segments = 2,
): string {
  if (!file) return source ?? "";
  const line = source && source.length > file.length ? source.slice(file.length + 1) : "";
  const tail = REMOTE_URL.test(file) ? shortRemoteUrl(file, segments) : tailPath(file, segments);
  return line ? `${tail}:${line}` : tail;
}

/**
 * Load a resolved CPU model. Accepts the `.cpu.json` directly, `latest`, or (as a
 * convenience) a recording path whose sibling `.cpu.json` is loaded instead.
 */
export async function loadCpuModel(file: string): Promise<CpuModel> {
  const abs = await resolveTarget(file, "cpu-model");
  const parsed = deserialize(await fs.readFile(abs, "utf8"), path.extname(abs).toLowerCase());
  if (parsed && Array.isArray((parsed as CpuModel).functions)) {
    assertSchemaVersion((parsed as CpuModel).meta?.schemaVersion, abs);
    return parsed as CpuModel;
  }
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
    if (fallback && Array.isArray((fallback as CpuModel).functions)) {
      assertSchemaVersion((fallback as CpuModel).meta?.schemaVersion, sibling);
      return fallback as CpuModel;
    }
  } catch (error) {
    // A missing sibling is the expected "no CPU model" case, reported below; a corrupt or
    // unreadable sibling surfaces as its own error rather than masquerading as absence.
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  const noModel = new Error(
    `${file} is not a CPU model. Pass the .cpu.json, or use 'latest' after a record run on a rung that samples CPU (the default or --breakdown, not --deep/--precise-wall).`,
  );
  (noModel as NodeJS.ErrnoException).code = "ENOCPUMODEL";
  throw noModel;
}
