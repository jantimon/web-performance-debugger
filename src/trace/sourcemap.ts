import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import type { SourceMapDiagnostics, SourceMapFailure, StackFrame } from "../model/recording.js";

/** ms before a remote .js / .map fetch is abandoned (keeps a hung CDN from stalling a run). */
const FETCH_TIMEOUT_MS = 5000;

function isHttpUrl(value: string | undefined): value is string {
  return !!value && (value.startsWith("http://") || value.startsWith("https://"));
}

/**
 * Resolve a sourcemap `source` (relative to the map's directory) to an absolute path.
 * Bundlers record sources against the directory string they were given, which may be a
 * symlink (macOS `mktemp` lives under /var, a symlink to /private/var) while Node
 * canonicalizes cwd to the real path; that one-segment difference throws off the `../`
 * depth and lands on a non-existent path (losing the file's package). If the direct
 * resolution is missing, toggle the `/private` prefix so it lands on the real file.
 */
function resolveOriginalSource(mapDir: string, relSource: string): string {
  const direct = path.resolve(mapDir, relSource);
  if (existsSync(direct)) return direct;
  const altDir = mapDir.startsWith("/private/")
    ? mapDir.slice("/private".length)
    : `/private${mapDir}`;
  const alt = path.resolve(altDir, relSource);
  return existsSync(alt) ? alt : direct;
}

/** Strip synthetic scheme prefixes (webpack://name/, ./) so a remote source reads cleanly. */
function cleanRemoteSource(source: string): string {
  const stripped = source.replace(/^[a-z-]+:\/\/[^/]*\//i, "").replace(/^\.?\//, "");
  return stripped || source;
}

/** The last `sourceMappingURL` reference in a JS body, if any. */
function sourceMappingURLOf(js: string): string | null {
  const matcher = /[#@]\s*sourceMappingURL=(\S+)/g;
  let last: string | null = null;
  for (let match = matcher.exec(js); match; match = matcher.exec(js)) last = match[1];
  return last;
}

/** Per reason, so one broken CDN cannot flood the recording with thousands of urls. */
const MAX_URLS_PER_REASON = 20;

type RawMap = { raw: string } | { failure: SourceMapFailure };

/** Decode a `data:application/json[;base64],...` sourcemap reference to raw JSON. */
function decodeDataUriMap(reference: string): string | null {
  const base64 = reference.match(/^data:application\/json;(?:charset=[^;]+;)?base64,(.*)$/s);
  if (base64) return Buffer.from(base64[1], "base64").toString("utf8");
  const plain = reference.match(/^data:application\/json(?:;charset=[^;]+)?,(.*)$/s);
  if (plain) return decodeURIComponent(plain[1]);
  return null;
}

async function fetchWithHeaders(url: string): Promise<{ text: string; headers: Headers } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok ? { text: await response.text(), headers: response.headers } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url: string): Promise<string | null> {
  return (await fetchWithHeaders(url))?.text ?? null;
}

/**
 * Best-effort mapping of bundled stack frames back to original source using sibling `.map`
 * files, inline data-URI maps, or (for remote scripts) the map auto-detected from the JS's
 * `sourceMappingURL` and fetched over the network.
 */
export class SourceMapResolver {
  private cache = new Map<string, TraceMap | null>();
  /** per attempted script: null = resolved, else why it failed. Keyed like `cache`, so each
   * script counts once no matter how many frames point at it. */
  private outcomes = new Map<string, SourceMapFailure | null>();

  private async loadLocalMap(jsFile: string): Promise<RawMap> {
    try {
      return { raw: await fs.readFile(`${jsFile}.map`, "utf8") };
    } catch {
      // no sibling .map; fall back to an inline data-URI map in the JS itself
    }
    let js: string;
    try {
      js = await fs.readFile(jsFile, "utf8");
    } catch {
      return { failure: "script-fetch-failed" };
    }
    const reference = sourceMappingURLOf(js);
    if (!reference) return { failure: "no-sourcemap-url" };
    // A non-data reference here means the sibling read above already missed the file it names.
    if (!reference.startsWith("data:")) return { failure: "map-fetch-failed" };
    const decoded = decodeDataUriMap(reference);
    return decoded ? { raw: decoded } : { failure: "map-parse-failed" };
  }

  private async loadRemoteMap(jsUrl: string): Promise<RawMap> {
    const script = await fetchWithHeaders(jsUrl);
    if (!script) return { failure: "script-fetch-failed" };
    // DevTools honours the SourceMap response header as well as the trailing comment, and
    // production builds commonly emit the header while stripping the comment. Headers.get is
    // case-insensitive, so the canonical `SourceMap` and legacy `X-SourceMap` both land here.
    const reference =
      sourceMappingURLOf(script.text) ??
      script.headers.get("sourcemap") ??
      script.headers.get("x-sourcemap");
    if (!reference) return { failure: "no-sourcemap-url" };
    if (reference.startsWith("data:")) {
      const decoded = decodeDataUriMap(reference);
      return decoded ? { raw: decoded } : { failure: "map-parse-failed" };
    }
    const raw = await fetchText(new URL(reference, jsUrl).href);
    return raw ? { raw } : { failure: "map-fetch-failed" };
  }

  private async loadMap(target: string): Promise<TraceMap | null> {
    if (this.cache.has(target)) return this.cache.get(target)!;
    let map: TraceMap | null = null;
    let failure: SourceMapFailure | undefined;
    try {
      const result = isHttpUrl(target)
        ? await this.loadRemoteMap(target)
        : await this.loadLocalMap(target);
      if ("raw" in result) {
        try {
          map = new TraceMap(result.raw);
        } catch {
          failure = "map-parse-failed";
        }
      } else {
        failure = result.failure;
      }
    } catch {
      failure = "map-parse-failed";
    }
    this.cache.set(target, map);
    this.outcomes.set(target, failure ?? null);
    return map;
  }

  /**
   * What happened to every script this resolver tried to map. Scripts skipped before an attempt
   * (non-JS targets, frames with no line) are not counted: nothing was tried for them.
   */
  diagnostics(): SourceMapDiagnostics {
    const failed: Partial<Record<SourceMapFailure, string[]>> = {};
    let resolved = 0;
    for (const [target, failure] of this.outcomes) {
      if (failure == null) {
        resolved++;
        continue;
      }
      const urls = (failed[failure] ??= []);
      if (urls.length < MAX_URLS_PER_REASON) urls.push(target);
    }
    const diagnostics: SourceMapDiagnostics = { scripts: this.outcomes.size, resolved };
    if (Object.keys(failed).length) diagnostics.failed = failed;
    return diagnostics;
  }

  /** Mutate a frame in place, mapping `.source:line:col` to original source. */
  async resolveFrame(frame: StackFrame): Promise<void> {
    // local served file (frame.source) or a remote script url (frame.remote)
    const target = frame.source ?? (frame.remote ? frame.url : undefined);
    if (!target || frame.line == null) return;
    if (!/\.(c|m)?js$/.test(target.split("?")[0])) return;
    const map = await this.loadMap(target);
    if (!map) return;
    // trace stack lines are 1-based; trace-mapping wants 1-based line, 0-based column.
    const pos = originalPositionFor(map, {
      line: frame.line,
      column: Math.max(0, (frame.column ?? 1) - 1),
    });
    if (pos.source == null || pos.line == null) return;
    frame.bundled = `${target}:${frame.line}:${frame.column ?? 0}`;
    frame.source = frame.remote
      ? cleanRemoteSource(pos.source)
      : resolveOriginalSource(path.dirname(target), pos.source);
    frame.line = pos.line;
    frame.column = pos.column ?? undefined;
    // the map's original identifier, when present (best-effort; absent on many segments)
    if (pos.name) frame.originalName = pos.name;
  }

  async resolveStack(stack: StackFrame[]): Promise<void> {
    for (const frame of stack) await this.resolveFrame(frame);
  }
}
