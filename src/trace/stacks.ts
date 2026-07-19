import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NormalizedEvent, StackFrame } from "../model/recording.js";
import { SourceMapResolver } from "./sourcemap.js";

interface RawFrame {
  functionName?: string;
  url?: string;
  scriptId?: string | number;
  lineNumber?: number;
  columnNumber?: number;
}

/**
 * Pull the JS stack out of a trace event's args. Chrome puts it in different
 * places depending on the event:
 *   - Layout / UpdateLayoutTree                -> args.beginData.stackTrace
 *   - *InvalidationTracking / TimerFire / rAF  -> args.data.stackTrace
 *   - FunctionCall / EvaluateScript            -> a single frame in args.data
 */
export function extractStack(args: unknown): StackFrame[] | undefined {
  const argsObj = args as any;
  if (!argsObj || typeof argsObj !== "object") return undefined;
  const data = argsObj.beginData ?? argsObj.data ?? argsObj;

  let raw: RawFrame[] | undefined = data?.stackTrace;
  if ((!raw || !raw.length) && (data?.url || data?.functionName)) {
    raw = [
      {
        functionName: data.functionName,
        url: data.url,
        lineNumber: data.lineNumber,
        columnNumber: data.columnNumber,
        scriptId: data.scriptId,
      },
    ];
  }
  if (!raw || !raw.length) return undefined;

  return raw
    .filter((frame) => frame && (frame.url || frame.functionName))
    .map((frame) => ({
      functionName: frame.functionName || undefined,
      url: frame.url || undefined,
      line: typeof frame.lineNumber === "number" ? frame.lineNumber : undefined,
      column: typeof frame.columnNumber === "number" ? frame.columnNumber : undefined,
    }));
}

/**
 * Pull the Gecko cause stack (the WRITE that dirtied a flush) out of a Reflow/Styles marker event.
 * Gecko stashes it under `args.data.invalidationStack` (leaf-first JS frames), a different key from
 * the read-site `stackTrace` above, so it never becomes a blame `at`. Undefined on chrome events,
 * which carry no such key.
 */
export function extractInvalidationStack(args: unknown): StackFrame[] | undefined {
  const data = (args as { data?: { invalidationStack?: RawFrame[] } } | undefined)?.data;
  const raw = data?.invalidationStack;
  if (!raw || !raw.length) return undefined;
  return raw
    .filter((frame) => frame && (frame.url || frame.functionName))
    .map((frame) => ({
      functionName: frame.functionName || undefined,
      url: frame.url || undefined,
      line: typeof frame.lineNumber === "number" ? frame.lineNumber : undefined,
      column: typeof frame.columnNumber === "number" ? frame.columnNumber : undefined,
    }));
}

/** Rewrite served (http://127.0.0.1:PORT/...) urls back to local file paths. */
export function makeSourceResolver(serverUrl: string, root: string) {
  return (frame: StackFrame): StackFrame => {
    if (frame.url && frame.url.startsWith(serverUrl)) {
      const rel = decodeURIComponent(frame.url.slice(serverUrl.length).split("?")[0]).replace(
        /^\//,
        "",
      );
      frame.source = path.join(root, rel);
    } else if (frame.url && !frame.url.startsWith("http")) {
      frame.source = frame.url;
    } else if (frame.url) {
      // a remote (http) script not served by us, e.g. a CDN bundle on a profiled --url
      // site; its sourcemap is fetched from the JS's sourceMappingURL during resolution.
      frame.remote = true;
    }
    return frame;
  };
}

/**
 * Resolver for the node runtime (--target node): V8 reports file:// urls for ESM and
 * "node:" urls for builtins. Convert file:// to a local path so sourcemap + package
 * resolution apply; leave node: builtins for the (node) bucket downstream.
 */
export function makeNodeSourceResolver() {
  return (frame: StackFrame): StackFrame => {
    if (!frame.url) return frame;
    if (frame.url.startsWith("file://")) {
      try {
        frame.source = fileURLToPath(frame.url);
      } catch {
        // malformed file url; leave unresolved
      }
    } else if (!frame.url.startsWith("node:") && !frame.url.startsWith("http")) {
      frame.source = frame.url;
    }
    return frame;
  };
}

/**
 * The wpd source files whose `page.evaluate` calls inject wpd's OWN page-side helpers: the driver's
 * step marks / INP observer / settle, and the bench harness runner. Puppeteer stamps an evaluated
 * function's sourceURL as `pptr:<fn>;<encoded call site>`, so a frame from one of these files is
 * wpd's own, not the user's. A driver-mode USER `page.evaluate` callback carries the same `pptr:`
 * scheme but a call site inside the user's module, so it is NOT one of these and must survive.
 */
const WPD_EVALUATE_SITES = [
  "/browser/driver.",
  "/browser/settle.",
  "/browser/harness.",
  "/record/runpass.",
];

/** True for urls injected by the tool itself (puppeteer internals/harness or node-runtime runner). */
export function isToolFrameUrl(url: string | undefined): boolean {
  if (!url) return false;
  if (url.startsWith("debugger://")) return true;
  if (
    // page.evaluate'd code under older puppeteer (its legacy evaluation sourceURL)
    url.includes("__puppeteer_evaluation_script__") ||
    // Firefox/BiDi attributes page.evaluate code to the served host page url, so the
    // bench harness loop lands on the blank host page; drop it (not user code).
    url.includes("/__wpd_blank__") ||
    // the in-process node-runtime driver loop (not user code)
    url.includes("/runtime/node.")
  )
    return true;
  if (url.startsWith("pptr:")) {
    // Puppeteer's own internal frames.
    if (url.startsWith("pptr:internal")) return true;
    // A `pptr:<fn>;<encoded call site>` frame: drop it ONLY when the call site is one of wpd's own
    // injection points. A user's driver-mode page.evaluate callback gets the same scheme, and its
    // frames are real user code that must reach blame/cpu. The site is percent-encoded in the url,
    // so decode before matching (the `/` separators would otherwise read as `%2F`).
    let site = url;
    try {
      site = decodeURIComponent(url);
    } catch {
      // malformed percent-encoding: match against the raw url instead
    }
    return WPD_EVALUATE_SITES.some((fragment) => site.includes(fragment));
  }
  return false;
}

/** Frames injected by puppeteer itself (our harness), not user source. */
function isToolFrame(frame: StackFrame): boolean {
  return isToolFrameUrl(frame.url);
}

/**
 * Make an absolute source path relative to the project root: shorter output, portable
 * recordings, and stable cpu-diff joins across machines/checkouts. Leaves urls, "node:"
 * builtins, and paths outside root untouched (path.isAbsolute is false for the first two).
 */
export function relativizeSource(where: string | undefined, root: string): string | undefined {
  if (!where || !path.isAbsolute(where)) return where;
  const rel = path.relative(root, where);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : where;
}

/** First frame that has a resolvable location, formatted "source:line:col". */
export function topLocation(stack: StackFrame[] | undefined): string | undefined {
  if (!stack) return undefined;
  for (const frame of stack) {
    if (isToolFrame(frame)) continue;
    const where = frame.source ?? frame.url;
    if (where) {
      const line = frame.line != null ? `:${frame.line}` : "";
      const col = frame.column != null ? `:${frame.column}` : "";
      return `${where}${line}${col}`;
    }
  }
  return undefined;
}

/**
 * Attach resolved stacks + top location to every event that carries one.
 *
 * Pass `maps` to share one resolver (its cache, and its diagnostics) across every call in a run:
 * a `record` run resolves stacks twice and builds a CPU model, and each would
 * otherwise re-fetch the same remote script and map.
 */
export async function attachStacks(
  events: NormalizedEvent[],
  serverUrl: string,
  root: string,
  maps: SourceMapResolver = new SourceMapResolver(),
): Promise<void> {
  const resolve = makeSourceResolver(serverUrl, root);
  for (const event of events) {
    const stack = extractStack(event.args);
    if (!stack) continue;
    stack.forEach(resolve);
    await maps.resolveStack(stack); // bundle -> original source (best effort)
    // Relativize after resolution (the resolvers read absolute paths from disk).
    for (const frame of stack) frame.source = relativizeSource(frame.source, root);
    event.stack = stack;
    event.at = topLocation(stack);
  }
  // Resolve the Gecko cause stack (firefox marker events) the same way, so `query get` shows local
  // sources and the firefox --deep dirtied-by report has a write line. This is the WRITE, kept off
  // `at` on purpose (the read-site stays the blame answer). A no-op on chrome (no invalidationStack).
  for (const event of events) {
    const cause = extractInvalidationStack(event.args);
    if (!cause) continue;
    cause.forEach(resolve);
    await maps.resolveStack(cause);
    for (const frame of cause) frame.source = relativizeSource(frame.source, root);
    (event.args as { data: { invalidationStack: StackFrame[] } }).data.invalidationStack = cause;
    const writeAt = topLocation(cause);
    if (writeAt) event.dirtiedBy = { at: writeAt };
  }
}
