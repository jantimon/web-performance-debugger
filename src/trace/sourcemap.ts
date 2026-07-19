import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import type { SourceMapDiagnostics, SourceMapFailure, StackFrame } from "../model/recording.js";

/** ms before a single remote .js / .map fetch is abandoned (keeps a hung CDN from stalling a run). */
const FETCH_TIMEOUT_MS = 5000;

/** Overall wall budget for ALL remote sourcemap work in one run. A heavy site can name hundreds of
 * scripts, each up to FETCH_TIMEOUT_MS; without a run-wide ceiling that is minutes of stall. Once
 * spent, remaining lookups record `fetch-budget-exhausted` and their frames keep minified names. */
const REMOTE_BUDGET_MS = 30_000;

/** Response-size caps: a map is bigger than its script, but neither should be able to exhaust memory
 * on a hostile or misbehaving server. Enforced by content-length AND by streaming (a lying/absent
 * content-length still aborts once the cap is crossed). */
const MAX_SCRIPT_BYTES = 20 * 1024 * 1024;
const MAX_MAP_BYTES = 50 * 1024 * 1024;

/** Concurrent remote fetches. Distinct scripts resolve in parallel up to this, instead of strictly
 * serial (minutes on a heavy site); the per-script cache/in-flight dedup keeps it one fetch each. */
const MAX_CONCURRENT_FETCHES = 4;

/** Redirect hops followed manually (each hop is re-checked against the fetch policy). */
const MAX_REDIRECTS = 5;

function isHttpUrl(value: string | undefined): value is `http${string}` {
  return !!value && (value.startsWith("http://") || value.startsWith("https://"));
}

/**
 * Obviously-private / loopback / link-local host, by hostname or IP literal. Not a full RFC1918
 * resolver (no DNS lookup): it matches the literal forms a sourcemap URL carries directly, which is
 * where the SSRF risk on a public --url site actually lives.
 */
export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "::" || host === "0.0.0.0") return true;
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10)
  if (/^f[cd][0-9a-f]{2}:/.test(host) || host.startsWith("fe80:")) return true;
  const parts = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!parts) return false;
  const [first, second] = [Number(parts[1]), Number(parts[2])];
  if (first === 0 || first === 127 || first === 10) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  if (first === 169 && second === 254) return true;
  return false;
}

/**
 * Why a fetch to `targetUrl` is refused, or null if allowed.
 *
 * - "scheme": anything but http(s). Blocks a redirect landing on file:/data:/etc.
 * - "private": the target resolves to a private/loopback host while the profiled page is PUBLIC.
 *   A public site's bundle should never make wpd reach into the operator's internal network. When
 *   the page itself is private/loopback (a served fixture, a localhost dev server), private targets
 *   are expected and allowed -- that is the common wpd case, so `pagePrivate` gates the rule.
 */
export function fetchBlockReason(
  targetUrl: string,
  pagePrivate: boolean,
): "scheme" | "private" | null {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return "scheme";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "scheme";
  if (!pagePrivate && isPrivateHostname(parsed.hostname)) return "private";
  return null;
}

/** Is the profiled page itself on a private/loopback host? Unparseable => treat as private (the
 * common local/served case), so an odd page url never turns fetches off. */
function isPageUrlPrivate(pageUrl: string): boolean {
  try {
    return isPrivateHostname(new URL(pageUrl).hostname);
  } catch {
    return true;
  }
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

/** What kind of body is being fetched: picks the size cap and the generic-failure reason. */
type FetchKind = "script" | "map";

type FetchOutcome =
  | { ok: true; text: string; headers: Headers }
  | { ok: false; failure: SourceMapFailure };

function genericFailure(kind: FetchKind): SourceMapFailure {
  return kind === "map" ? "map-fetch-failed" : "script-fetch-failed";
}

function tooLargeFailure(kind: FetchKind): SourceMapFailure {
  return kind === "map" ? "map-too-large" : "script-too-large";
}

/** Read a response body to text, aborting (and reporting too-large) the moment the cap is crossed.
 * Streams so a lying or absent content-length cannot smuggle an over-cap body through. */
async function readCapped(
  response: Response,
  cap: number,
  kind: FetchKind,
  abort: () => void,
): Promise<FetchOutcome> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) {
    abort();
    return { ok: false, failure: tooLargeFailure(kind) };
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > cap) return { ok: false, failure: tooLargeFailure(kind) };
    return { ok: true, text, headers: response.headers };
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > cap) {
      abort();
      return { ok: false, failure: tooLargeFailure(kind) };
    }
    chunks.push(value);
  }
  return { ok: true, text: Buffer.concat(chunks).toString("utf8"), headers: response.headers };
}

/**
 * A single remote fetch, bounded on every axis a hostile or slow server can abuse: the run-wide time
 * budget (`deadlineMs`), the per-fetch timeout, the response-size cap, and the fetch policy (scheme +
 * private-host), re-checked at every manually-followed redirect hop so a 302 cannot escape it.
 */
export async function boundedFetch(
  url: string,
  kind: FetchKind,
  pagePrivate: boolean,
  deadlineMs: number,
): Promise<FetchOutcome> {
  const cap = kind === "map" ? MAX_MAP_BYTES : MAX_SCRIPT_BYTES;
  let currentUrl = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (fetchBlockReason(currentUrl, pagePrivate)) return { ok: false, failure: "blocked-fetch" };
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) return { ok: false, failure: "fetch-budget-exhausted" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(FETCH_TIMEOUT_MS, remainingMs));
    try {
      const response = await fetch(currentUrl, {
        signal: controller.signal,
        redirect: "manual",
      });
      // redirect: "manual" surfaces the 3xx to us so the destination is policy-checked before we
      // follow it (an automatic follow would fetch a private host before we could refuse).
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) return { ok: false, failure: genericFailure(kind) };
        currentUrl = new URL(location, currentUrl).href;
        continue;
      }
      // 401/403 is a distinct, actionable outcome: the resource exists but is auth-walled, and
      // wpd's node-side fetch sends no cookies/credentials, so the generic "could not be fetched"
      // remedy (which mentions CORS, a browser-only concept) would misdirect.
      if (response.status === 401 || response.status === 403)
        return { ok: false, failure: "auth-required" };
      if (!response.ok) return { ok: false, failure: genericFailure(kind) };
      return await readCapped(response, cap, kind, () => controller.abort());
    } catch {
      return { ok: false, failure: genericFailure(kind) };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, failure: genericFailure(kind) };
}

/**
 * A line this long is machine-generated. Hand-written source, however sloppy, does not run to
 * hundreds of characters on one line; a minifier joins whole modules into one. Deliberately far
 * above anything a formatter would emit (oxfmt/prettier cap around 100) so the test is decisive
 * rather than a judgement call.
 */
const MINIFIED_LINE_LENGTH = 500;

/**
 * Does this script body look like build output rather than source?
 *
 * Used to answer a question a failed sourcemap CANNOT answer on its own: a missing map only
 * matters if the file is generated. Plain source has no map because it needs none -- its frames
 * already point at real lines with real names -- so warning about it is a false alarm. A minified
 * bundle with no map is the opposite: every frame is a lie wearing a real package name.
 *
 * Scans for a single long line rather than an average, so one huge bundled line is enough and a
 * bundle with a banner comment or a few short lines still trips it.
 */
function looksMinified(js: string): boolean {
  let lineLength = 0;
  for (let index = 0; index < js.length; index++) {
    if (js.charCodeAt(index) === 10 /* \n */) {
      lineLength = 0;
      continue;
    }
    if (++lineLength > MINIFIED_LINE_LENGTH) return true;
  }
  return false;
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
  /** scripts that read as build output (see looksMinified). Only meaningful for scripts whose map
   * did NOT resolve: those are the ones whose frames keep minified names and a bundle-shaped
   * package rollup. Keyed like `cache`. */
  private minified = new Set<string>();
  /** per script whose map RESOLVED: how many frame lookups the map answered (hits) vs returned no
   * mapping for (misses). Per-lookup, not per distinct position (each frame is queried once per
   * pass). A miss keeps the frame's minified/remote identity and buckets it by origin, so a map that
   * loads fine can still leak attribution -- invisible to `outcomes`, which only records LOAD
   * failures. Keyed like `cache`. */
  private positionCounts = new Map<string, { misses: number; hits: number }>();
  /** in-flight loads, so two concurrent lookups of one script share the single fetch rather than
   * racing (the cache is only populated after the await; `warm` fires many at once). Keyed like
   * `cache`. */
  private inflight = new Map<string, Promise<TraceMap | null>>();
  /** True when the profiled page is itself on a private/loopback host, which makes private fetch
   * targets expected (served fixtures, localhost dev). A public page cannot reach private hosts. */
  private readonly pagePrivate: boolean;
  /** Absolute wall deadline for ALL remote fetches, set lazily on the first one so the run's trace
   * time before any fetch does not eat the budget. */
  private remoteDeadline: number | null = null;
  /** Concurrency gate for remote fetches (a hand-rolled counting semaphore). */
  private activeFetches = 0;
  private fetchWaiters: (() => void)[] = [];

  /**
   * @param options.pageUrl the profiled page's URL (--url), used to decide whether private fetch
   *   targets are expected. Absent (bench/module/--html) means the page is wpd's own localhost
   *   server, i.e. private, so private targets are permitted.
   */
  constructor(options: { pageUrl?: string } = {}) {
    this.pagePrivate = options.pageUrl == null || isPageUrlPrivate(options.pageUrl);
  }

  private async acquireFetchSlot(): Promise<void> {
    if (this.activeFetches < MAX_CONCURRENT_FETCHES) {
      this.activeFetches++;
      return;
    }
    await new Promise<void>((resolve) => this.fetchWaiters.push(resolve));
  }

  private releaseFetchSlot(): void {
    const next = this.fetchWaiters.shift();
    // Hand the slot directly to the next waiter (activeFetches unchanged); only drop the count when
    // nobody is waiting.
    if (next) next();
    else this.activeFetches--;
  }

  /** One remote fetch, run under the concurrency gate and the run-wide time budget. */
  private async remoteFetch(url: string, kind: FetchKind): Promise<FetchOutcome> {
    this.remoteDeadline ??= Date.now() + REMOTE_BUDGET_MS;
    await this.acquireFetchSlot();
    try {
      return await boundedFetch(url, kind, this.pagePrivate, this.remoteDeadline);
    } finally {
      this.releaseFetchSlot();
    }
  }

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
    // The body is already in hand for the sourceMappingURL scan, so the minification test is free.
    if (looksMinified(js)) this.minified.add(jsFile);
    const reference = sourceMappingURLOf(js);
    if (!reference) return { failure: "no-sourcemap-url" };
    if (reference.startsWith("data:")) {
      const decoded = decodeDataUriMap(reference);
      return decoded ? { raw: decoded } : { failure: "map-parse-failed" };
    }
    // A non-data reference (e.g. `maps/app.js.map`) resolves against the JS file's own directory,
    // mirroring the remote branch's `new URL(reference, jsUrl)`. The sibling `${jsFile}.map` read
    // above only covers the conventional adjacent name, so a map in a sibling directory reaches here.
    if (isHttpUrl(reference)) {
      const fetched = await this.remoteFetch(reference, "map");
      return fetched.ok ? { raw: fetched.text } : { failure: fetched.failure };
    }
    try {
      return { raw: await fs.readFile(path.resolve(path.dirname(jsFile), reference), "utf8") };
    } catch {
      // A root-absolute URL path (`/maps/app.js.map`) names a location under the SERVING root,
      // which a filesystem read cannot know; path.resolve read it as a filesystem-absolute path
      // above. Best effort: re-anchor it under the JS file's own directory (dist/app.js ->
      // dist/maps/app.js.map, the common bundle layout) before reporting failure.
      if (reference.startsWith("/")) {
        try {
          return {
            raw: await fs.readFile(
              path.join(path.dirname(jsFile), ...reference.split("/")),
              "utf8",
            ),
          };
        } catch {
          return { failure: "map-fetch-failed" };
        }
      }
      return { failure: "map-fetch-failed" };
    }
  }

  private async loadRemoteMap(jsUrl: string): Promise<RawMap> {
    const script = await this.remoteFetch(jsUrl, "script");
    if (!script.ok) return { failure: script.failure };
    if (looksMinified(script.text)) this.minified.add(jsUrl);
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
    const fetched = await this.remoteFetch(new URL(reference, jsUrl).href, "map");
    return fetched.ok ? { raw: fetched.text } : { failure: fetched.failure };
  }

  private async loadMap(target: string): Promise<TraceMap | null> {
    if (this.cache.has(target)) return this.cache.get(target)!;
    const existing = this.inflight.get(target);
    if (existing) return existing;
    const load = this.loadMapUncached(target).then((map) => {
      this.inflight.delete(target);
      return map;
    });
    this.inflight.set(target, load);
    return load;
  }

  private async loadMapUncached(target: string): Promise<TraceMap | null> {
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
   * Pre-load the maps for a set of distinct scripts concurrently (bounded by MAX_CONCURRENT_FETCHES),
   * so the serial per-frame resolution below hits the cache instead of fetching one script at a time.
   * The per-script cache/in-flight dedup keeps it one fetch each. Non-http targets are ignored: local
   * reads are cheap and need no warming.
   */
  async warm(targets: Iterable<string>): Promise<void> {
    const distinct = [...new Set([...targets].filter((target) => isHttpUrl(target)))];
    await Promise.all(distinct.map((target) => this.loadMap(target)));
  }

  /**
   * What happened to every script this resolver tried to map. Scripts skipped before an attempt
   * (non-JS targets, frames with no line) are not counted: nothing was tried for them.
   */
  diagnostics(): SourceMapDiagnostics {
    const failed: Partial<Record<SourceMapFailure, string[]>> = {};
    let resolved = 0;
    let unmappedBundles = 0;
    for (const [target, failure] of this.outcomes) {
      if (failure == null) {
        resolved++;
        continue;
      }
      // Build output whose map did not resolve: its frames keep minified names and its cost rolls
      // up under whatever package.json happens to sit above the bundle. This -- not "a map was
      // missing" -- is the condition worth warning about.
      if (this.minified.has(target)) unmappedBundles++;
      const urls = (failed[failure] ??= []);
      if (urls.length < MAX_URLS_PER_REASON) urls.push(target);
    }
    const diagnostics: SourceMapDiagnostics = {
      scripts: this.outcomes.size,
      resolved,
      unmappedBundles,
    };
    if (Object.keys(failed).length) diagnostics.failed = failed;
    // Scripts whose map resolved yet position-missed at least one frame. Ranked by miss count and
    // capped like `failed`, so `scripts`/`resolved` stay the authoritative totals. The script url
    // breaks ties, so which scripts survive the cap (and their order) is stable across runs rather
    // than riding Map insertion order. Each `{misses,hits}` is copied, so a caller mutating the
    // returned diagnostics cannot reach back into the resolver's live counters.
    const missed = [...this.positionCounts.entries()]
      .filter(([, counts]) => counts.misses > 0)
      .sort(
        ([leftScript, left], [rightScript, right]) =>
          right.misses - left.misses || leftScript.localeCompare(rightScript),
      )
      .slice(0, MAX_URLS_PER_REASON)
      .map(([script, counts]) => [script, { misses: counts.misses, hits: counts.hits }] as const);
    if (missed.length) diagnostics.positionMisses = Object.fromEntries(missed);
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
    const positions = this.positionCounts.get(target) ?? { misses: 0, hits: 0 };
    if (pos.source == null || pos.line == null) {
      // The map loaded but has no mapping for this line/col: the frame keeps its minified/remote
      // identity and buckets by origin. `outcomes` records only LOAD failures, so count the miss
      // here or the leak stays invisible.
      positions.misses++;
      this.positionCounts.set(target, positions);
      return;
    }
    positions.hits++;
    this.positionCounts.set(target, positions);
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
