import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import type { StackFrame } from "../model/recording.js";

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

/** Decode a `data:application/json[;base64],...` sourcemap reference to raw JSON. */
function decodeDataUriMap(reference: string): string | null {
  const base64 = reference.match(/^data:application\/json;(?:charset=[^;]+;)?base64,(.*)$/s);
  if (base64) return Buffer.from(base64[1], "base64").toString("utf8");
  const plain = reference.match(/^data:application\/json(?:;charset=[^;]+)?,(.*)$/s);
  if (plain) return decodeURIComponent(plain[1]);
  return null;
}

async function fetchText(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok ? await response.text() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Best-effort mapping of bundled stack frames back to original source using sibling `.map`
 * files, inline data-URI maps, or (for remote scripts) the map auto-detected from the JS's
 * `sourceMappingURL` and fetched over the network.
 */
export class SourceMapResolver {
  private cache = new Map<string, TraceMap | null>();

  private async loadLocalMap(jsFile: string): Promise<string | null> {
    try {
      return await fs.readFile(`${jsFile}.map`, "utf8");
    } catch {
      const js = await fs.readFile(jsFile, "utf8");
      const reference = sourceMappingURLOf(js);
      return reference && reference.startsWith("data:") ? decodeDataUriMap(reference) : null;
    }
  }

  private async loadRemoteMap(jsUrl: string): Promise<string | null> {
    const js = await fetchText(jsUrl);
    if (!js) return null;
    const reference = sourceMappingURLOf(js);
    if (!reference) return null;
    if (reference.startsWith("data:")) return decodeDataUriMap(reference);
    return fetchText(new URL(reference, jsUrl).href);
  }

  private async loadMap(target: string): Promise<TraceMap | null> {
    if (this.cache.has(target)) return this.cache.get(target)!;
    let map: TraceMap | null = null;
    try {
      const raw = isHttpUrl(target)
        ? await this.loadRemoteMap(target)
        : await this.loadLocalMap(target);
      if (raw) map = new TraceMap(raw);
    } catch {
      map = null;
    }
    this.cache.set(target, map);
    return map;
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
