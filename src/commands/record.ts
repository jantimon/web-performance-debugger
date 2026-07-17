import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchBrowser, GECKO_MIN_INTERVAL_MS, type HeadlessMode } from "../browser/launch.js";
import { capsFor, type BrowserCaps, type BrowserName } from "../browser/backend.js";
import { startStaticServer, type StaticServer } from "../browser/server.js";
import { parseGecko, geckoToRawCpuProfile, geckoToRenderingEvents } from "../profile/gecko.js";
import { runHarness } from "../browser/harness.js";
import { runDriver, type DriverStep } from "../browser/driver.js";
import { applyCpuThrottle, applyNetworkPreset } from "../browser/throttle.js";
import { traceCategories, breakdownTraceCategories } from "../trace/categories.js";
import { parseTrace, findWindow, findSteps } from "../trace/parse.js";
import { labelWindows, mergeSteps, type LabelledWindow, type MergedStep } from "../trace/steps.js";
import { attachStacks } from "../trace/stacks.js";
import { SourceMapResolver } from "../trace/sourcemap.js";
import { markForced } from "../trace/analysis.js";
import { computeSpanBreakdown, type BreakdownSample } from "../trace/breakdown.js";
import {
  enableMetrics,
  snapshotMetricsIfAvailable,
  metricsDelta,
  startCpuProfile,
  stopCpuProfile,
} from "../metrics/cdp.js";
import { buildSummary } from "../metrics/summarize.js";
import {
  buildCpuModel,
  packagesByProfileNode,
  DEFAULT_CPU_INTERVAL_US,
  type RawCpuProfile,
} from "../profile/cpuprofile.js";
import { printCpuHeadline, printCpuBreakdown, printSpanBreakdowns } from "./cpu.js";
import { printSummary } from "./summaryView.js";
import { kv, num, sparkline } from "../output/ascii.js";
import { bold, cyan, dim } from "../output/color.js";
import { buildDigest } from "./digest.js";
import { writePointer } from "./resolve.js";
import { serialize, extFor, type Format } from "../output/format.js";
import { VERSION, TOOL } from "../version.js";
import { SCHEMA_VERSION } from "../schema.js";
import type {
  BlameSemantic,
  CpuModel,
  NormalizedEvent,
  Recording,
  RecordingMeta,
  ScreenshotRefs,
  SourceMapDiagnostics,
  SourceMapFailure,
  SpanBreakdown,
  StepIndex,
  StepIndexEntry,
  TimingEntry,
} from "../model/recording.js";

const US_PER_MS = 1000;

export interface RecordOptions {
  module: string;
  fn: string;
  /** browser backend: "chrome" (default, full CDP) or "firefox" (BiDi + Gecko profiler) */
  browser?: BrowserName;
  html?: string;
  url?: string;
  iterations: number;
  warmup: number;
  out?: string;
  headless: boolean;
  /** chrome headless flavour: "new" (default) or "shell" (~120Hz frames); ignored when headed/firefox */
  headlessMode?: HeadlessMode;
  /** persistent Chrome profile dir (resolved absolute); reuse one login across passes/runs */
  userDataDir?: string;
  screenshot?: "before" | "after" | "both";
  isolate: boolean;
  settleMs: number;
  format: Format;
  /** driver (puppeteer) mode: run executes in Node and receives { page, ctx } */
  driver: boolean;
  /** artificial slowdown: CPU throttling multiplier (e.g. 4 = 4x slower) */
  cpuThrottle?: number;
  /** artificial slowdown: network preset (slow-3g, fast-3g, slow-4g, offline) */
  network?: string;
  /** capture a CPU sampling profile (writes .cpuprofile + .cpu model). The CLI defaults this on;
   * it rides the timing pass, so it costs no extra pass. */
  cpuProfile?: boolean;
  /** CPU sampler interval in microseconds (default DEFAULT_CPU_INTERVAL_US) */
  cpuIntervalUs?: number;
  /** execution runtime: "chrome" (default, Puppeteer page) or "node" (in-process V8, CPU only) */
  runtime?: "chrome" | "node";
  /** CDP protocol timeout (ms); raise above the 180s default for heavy traced interactions */
  protocolTimeoutMs?: number;
  /** run the trace pass (default true); false = counts-only (CDP + optional CPU), no paint/forced/invalidation */
  trace?: boolean;
  /** include the invalidationTracking trace category (default true); false drops it to cut overhead on invalidation-heavy pages */
  invalidationTracking?: boolean;
  /**
   * Single-pass seven-slice breakdown mode (chrome only): a light trace (no `.stack`, no
   * invalidationTracking) fused with the CPU sampler in ONE pass, producing a reconciling
   * js/style/layout/paint/gc/other/idle decomposition per span. Cannot report forced-layout counts
   * or blame (they need `.stack`).
   */
  breakdown?: boolean;
}

interface PassSpec {
  name: string;
  /** null = run with tracing OFF (clean timing) */
  categories: string[] | null;
  /** capture a CPU sampling profile during this pass (tracing stays off) */
  cpu?: boolean;
  /**
   * Keep each trace event's pid/tid (parseTrace drops them otherwise). Only the --breakdown pass
   * sets this: the seven-slice engine tiles the renderer main thread and must tell it from
   * raster/compositor threads. Off elsewhere, so those recordings' events stay byte-for-byte.
   */
  keepThreadIds?: boolean;
  /** Firefox: run under the Gecko profiler; the shutdown dump yields CPU samples AND
   * layout/style markers (blame) from this one pass. */
  gecko?: boolean;
  /**
   * bench: timed iterations this pass runs, overriding --iterations. The trace pass runs 1
   * because its numbers are counts, which describe one iteration's work and must not scale with
   * --iterations; the timing pass runs them all because its numbers are wall samples, which only
   * mean something in bulk. Unset => --iterations.
   */
  iterations?: number;
  /**
   * bench: close the CDP counter bracket after the first timed iteration instead of around the
   * whole loop. Only for a pass that runs every iteration for wall yet whose counters should
   * describe one (the timing pass). A pass that is ALSO the only count source must not set this:
   * its trace-derived counts cover every iteration, so per-iteration CDP counts beside them put
   * two different windows in one summary (measured under --no-isolate: layoutCount 22 from one
   * iteration next to forcedLayoutCount 323 from eight).
   */
  bracketFirstIteration?: boolean;
}

/**
 * Says what a run's counts are scoped to, when --iterations makes the question real (at 1 there is
 * nothing to scale). Applies to both modes: --iterations repeats run() in either.
 *
 * Counts answer "how much work does one iteration cause"; wall answers "how long does it take",
 * which needs repetition. Summing counts over --iterations conflates the two and silently rescales
 * every threshold: `assert --max-layouts 30` would pass at --iterations 1 and fail at 10 on the
 * same page (measured: layoutCount 22 -> 102 -> 202 at 1/5/10). The pass plan keeps them apart, and
 * the lanes that cannot say so here.
 */
export function noteCountScope(
  specs: PassSpec[],
  opts: RecordOptions,
  caps: BrowserCaps,
): string | null {
  if (opts.iterations <= 1) return null;
  const tracePass = specs.find((spec) => spec.name === "trace");
  const geckoPass = specs.find((spec) => spec.name === "gecko");
  const breakdownPass = specs.find((spec) => spec.name === "breakdown");
  // --no-isolate: one pass carries wall AND counts, so it must run every iteration and its counts
  // are totals. Gecko: that pass is also the lane's only CPU sampler, and pinning it to one
  // iteration would starve the profile of samples, which costs more than the counts gain.
  // --breakdown: one fused pass (light trace + sampler) is the only pass, so it too carries wall AND
  // counts, runs every iteration, and its counts total.
  const totalling = (tracePass && tracePass.iterations !== 1) || geckoPass || breakdownPass;
  if (totalling) {
    const why = geckoPass
      ? "the Gecko pass is also this lane's CPU sampler, so it runs every iteration"
      : breakdownPass
        ? "--breakdown fuses the light trace and CPU sampler into one pass, which must run every iteration for the wall samples"
        : "--no-isolate collapses to one pass, which must run every iteration for the wall samples";
    // Driver per-step counts are unaffected: each measureStep brackets its own counters and
    // mergeSteps keeps the first iteration's, so only THIS recording's overall counts total up.
    // Saying "counts are totals" flatly would send a reader to re-derive per-step numbers that
    // are already right.
    const perStep = opts.driver
      ? " Per-step counts are unaffected: they describe the first timed iteration."
      : "";
    return `Counts (layout/style/paint/forced) on this recording are TOTALS across all ${opts.iterations} iterations, not one iteration's work: ${why}. A threshold like 'assert --max-layouts' therefore scales with --iterations. Use --iterations 1 to assert on counts.${perStep}`;
  }
  // Name only the mechanisms that actually ran: under --no-trace there is no trace pass, and
  // claiming one "runs a single iteration" would describe a pass that does not exist. The caps
  // gate is not redundant with bracketFirstIteration: runPass also requires cdpCounts to split,
  // so reading the spec alone would promise a CDP bracket on Firefox, where there are no CDP
  // counters and the note two lines up says every count is 0.
  const how: string[] = [];
  if (caps.cdpCounts && specs.some((spec) => spec.bracketFirstIteration))
    how.push("the CDP counters bracket the first iteration");
  if (tracePass?.iterations === 1) how.push("the trace pass runs a single iteration");
  if (!how.length) return null;
  return `Counts describe the FIRST timed iteration, not all ${opts.iterations} (${how.join("; ")}), so they mean the same at any --iterations. Wall/stats still come from all ${opts.iterations}.`;
}

/**
 * What this run's blame lines name, read off the pass plan that actually ran rather than the
 * browser name: the gecko pass is what produces Gecko's invalidation-site stacks, and the trace
 * pass is what produces Blink's flush-site ones, so a plan without either produces no blame and
 * gets no semantic (--target node, or Chrome with --no-trace). Deriving this from `opts` instead
 * would let a flag imply a pass that never ran.
 */
export function blameSemanticFor(specs: PassSpec[]): BlameSemantic | undefined {
  if (specs.some((spec) => spec.gecko)) return "invalidation-site";
  // Flush-site blame is Blink's stack at the forced flush, which needs the `.stack` category. The
  // --breakdown pass has categories but drops `.stack`, so it produces no blame; excluding it by
  // name keeps this from claiming a semantic for lines that were never captured.
  if (specs.some((spec) => spec.categories && spec.name !== "breakdown")) return "flush-site";
  return undefined;
}

interface PassResult {
  name: string;
  events: NormalizedEvent[];
  windowStart: number | null;
  windowEnd: number | null;
  cdpDelta: Record<string, number>;
  cdpBefore: Record<string, number>;
  cdpAfter: Record<string, number>;
  perIteration: number[];
  lifecycle: string[];
  marks: TimingEntry[];
  measures: TimingEntry[];
  screenshots?: ScreenshotRefs;
  /** driver mode: per-step wall time + clean CDP delta (from timing pass) */
  driverSteps?: DriverStep[];
  /** driver mode: this pass's own trace windows, already re-keyed from index to label */
  stepWindows?: LabelledWindow[];
  /** raw V8 CPU sampling profile (only on the cpu pass) */
  cpuProfile?: RawCpuProfile;
  /** Firefox: temp path of the raw Gecko shutdown dump, copied verbatim to the
   * .geckoprofile.json artifact and removed. Kept as a path, not a string: the dump can be
   * hundreds of MB and holding it would pin that for the rest of the run. */
  geckoDumpPath?: string;
  /** interval the CPU sampler actually ran at, read back from the profile itself */
  cpuSampleIntervalUs?: number;
}

function slug(label: string): string {
  return (
    label
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase()
      .slice(0, 40) || "step"
  );
}

function indexPathHint(outDir: string, base: string, ext: string): string {
  return path.join(outDir, `${base}.index${ext}`);
}

function toServedUrl(server: StaticServer, root: string, absFile: string): string {
  const rel = path.relative(root, absFile);
  if (rel.startsWith("..")) {
    throw new Error(
      `File ${absFile} must live within the working directory (${root}) so it can be served to the browser.`,
    );
  }
  return `${server.url}/${rel.split(path.sep).join("/")}`;
}

/** Persistent-profile path for meta: shorter of relative-to-root vs absolute, or null if unused. */
function shorterPath(root: string, absPath: string | undefined): string | null {
  if (!absPath) return null;
  const relative = path.relative(root, absPath);
  return relative && relative.length < absPath.length ? relative : absPath;
}

/**
 * An artifact path as the REPORT should show it: relative to cwd when that is shorter.
 *
 * Display only. The stored back-pointers stay absolute on purpose, so a recording can be reopened
 * from any directory; this is purely about the terminal, where an absolute path is both harder to
 * scan and something you may not want on screen -- a pasted report or a recorded terminal otherwise
 * carries your home directory with it.
 *
 * Falls back to absolute when relativizing does not help: an --out outside cwd would otherwise
 * become a worse `../../../tmp/x.json`.
 */
function displayPath(absPath: string): string {
  const relative = path.relative(process.cwd(), absPath);
  return relative && !relative.startsWith("..") && relative.length < absPath.length
    ? relative
    : absPath;
}

/** Plain-English remedy per failure reason, so the note says what to actually do. */
const SOURCEMAP_REMEDY: Record<SourceMapFailure, string> = {
  "no-sourcemap-url":
    "the bundle carries no sourceMappingURL comment and no SourceMap response header (many production builds strip both)",
  "script-fetch-failed": "the script could not be fetched (auth, CORS, or it is no longer served)",
  "map-fetch-failed": "the .map it names could not be fetched (commonly not deployed alongside it)",
  "map-parse-failed": "the .map it names is not a readable sourcemap",
};

/**
 * One honest sentence about sourcemap resolution, or null when there is nothing to say.
 *
 * "No sourcemap resolved" is NOT the trigger, because it is a different question from "can the
 * package rollup be believed". A plain unbundled `.mjs` has no map and needs none -- its frames
 * already carry real names and real lines -- so warning about it is a false alarm. Two things
 * actually cost you, and each is measured at the point it happens:
 *
 *   unmappedBundles  a script that IS build output (minified) whose map did not resolve: its
 *                    frames keep mangled names and roll up under whatever package.json sits above
 *                    the bundle, which reads as a real package. Local or remote.
 *   unmappedFrames   a frame whose owner could not be determined at all, bucketed by origin.
 *                    Remote-only: a local frame always has a known path.
 *
 * Neither alone is sufficient -- a local minified bundle has unmappedFrames 0 (we know its path),
 * and an unminified remote script has unmappedBundles 0 (yet we still cannot say whose it is).
 * Gating on `unmappedFrames` alone goes silent on exactly the local bundle this note exists for,
 * which is the failure this shape is designed against: when removing a false positive, check that
 * the true positive still fires.
 */
function sourcemapNote(diagnostics: SourceMapDiagnostics, unmappedFrames: number): string | null {
  const { scripts, resolved } = diagnostics;
  const unmappedBundles = diagnostics.unmappedBundles ?? 0;
  const reasons = Object.keys(diagnostics.failed ?? {}) as SourceMapFailure[];
  const why = reasons.map((reason) => `${reason} (${SOURCEMAP_REMEDY[reason]})`).join("; ");
  // A missing map cost nothing: no unmapped script was build output, and every frame found its
  // owner. Saying anything here would be crying wolf about plain source that needs no map.
  if (unmappedBundles === 0 && unmappedFrames === 0) return null;
  const damage = [
    unmappedBundles
      ? `${unmappedBundles} minified bundle(s) keep their mangled function names and roll up under whichever package.json sits above them, not their real packages`
      : null,
    unmappedFrames
      ? `${unmappedFrames} frame(s) could not be attributed to any package and are bucketed by origin, not as your app`
      : null,
  ]
    .filter(Boolean)
    .join("; ");
  const scope =
    resolved === 0
      ? `no sourcemap resolved for any of the ${scripts} script(s) profiled`
      : `sourcemaps resolved for only ${resolved} of ${scripts} script(s)`;
  return `WARNING: ${scope}, so 'query cpu --by package' cannot be believed for them: ${damage}. Reason(s): ${why}. See meta.sourcemaps for the urls.`;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** How long to wait for Firefox to flush its shutdown dump before giving up. Generous: a large
 * ring buffer serializes to a multi-hundred-MB file on a slow disk. */
const GECKO_DUMP_TIMEOUT_MS = 15_000;
/** Poll cadence while waiting for the dump. */
const GECKO_DUMP_POLL_MS = 250;
/** Consecutive equal sizes that count as "done growing" (the dump is written incrementally). */
const GECKO_DUMP_STABLE_READS = 3;

/** The Gecko sampling interval for this run: --cpu-interval is expressed in microseconds (the V8
 * unit) and Gecko takes milliseconds, clamped up to its ~1ms floor by geckoEnv. Unset => the floor. */
function geckoIntervalMs(opts: RecordOptions): number {
  return opts.cpuIntervalUs != null
    ? Math.max(GECKO_MIN_INTERVAL_MS, opts.cpuIntervalUs / US_PER_MS)
    : GECKO_MIN_INTERVAL_MS;
}

/** Firefox writes the Gecko shutdown dump asynchronously after browser.close(); wait for the
 * file to exist AND stop growing (stable across reads) before parsing it. */
async function waitForGeckoDump(
  dumpPath: string,
  timeoutMs = GECKO_DUMP_TIMEOUT_MS,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastSize = -1;
  let stableReads = 0;
  while (Date.now() < deadline) {
    let size = -1;
    try {
      size = (await fs.stat(dumpPath)).size;
    } catch {
      size = -1;
    }
    if (size > 0 && size === lastSize) {
      if (++stableReads >= GECKO_DUMP_STABLE_READS) return fs.readFile(dumpPath, "utf8");
    } else {
      stableReads = 0;
    }
    lastSize = size;
    await sleep(GECKO_DUMP_POLL_MS);
  }
  throw new Error(
    `Gecko profile dump was not written to ${dumpPath} within ${timeoutMs}ms (Firefox gecko pass).`,
  );
}

async function runPass(
  server: StaticServer,
  root: string,
  spec: PassSpec,
  opts: RecordOptions,
  mode: "module" | "html" | "url",
  absModule: string,
  shots: { before: boolean; after: boolean; dir: string; base: string } | null,
  maps: SourceMapResolver,
): Promise<PassResult> {
  const browserName: BrowserName = opts.browser ?? "chrome";
  const caps = capsFor(browserName);
  // Firefox: the Gecko pass profiles for its whole lifetime and dumps on exit; a fresh temp
  // file per pass keeps concurrent/retried runs from colliding.
  const geckoDumpPath = spec.gecko
    ? path.join(
        os.tmpdir(),
        `wpd-gecko-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
      )
    : undefined;
  const { browser, page, client } = await launchBrowser({
    browser: browserName,
    headless: opts.headless,
    headlessMode: opts.headlessMode,
    userDataDir: opts.userDataDir,
    protocolTimeoutMs: opts.protocolTimeoutMs,
    gecko: geckoDumpPath
      ? { dumpPath: geckoDumpPath, intervalMs: geckoIntervalMs(opts) }
      : undefined,
  });
  // On Firefox client is null; every CDP call is guarded by the caps object or this helper.
  const countsClient = caps.cdpCounts ? client : null;
  const snapshot = () => snapshotMetricsIfAvailable(countsClient);
  const screenshots: ScreenshotRefs = {};
  let result: PassResult;
  try {
    if (countsClient) await enableMetrics(countsClient);
    if (opts.cpuThrottle && client && caps.throttle)
      await applyCpuThrottle(client, opts.cpuThrottle);
    if (opts.network && client && caps.throttle) await applyNetworkPreset(client, opts.network);

    if (mode === "html") {
      await page.goto(toServedUrl(server, root, path.resolve(opts.html!)), {
        waitUntil: "load",
        timeout: 30000,
      });
    } else if (mode === "url") {
      await page.goto(opts.url!, { waitUntil: "load", timeout: 30000 });
    } else {
      // Same-origin blank page so the module import() below is not cross-origin.
      await page.goto(`${server.url}/__wpd_blank__`, { waitUntil: "load" });
    }

    if (shots?.before) {
      const screenshotPath = path.join(shots.dir, `${shots.base}.${spec.name}.before.png`);
      await page.screenshot({ path: screenshotPath as `${string}.png` });
      screenshots.before = screenshotPath;
    }

    let perIteration: number[];
    let lifecycle: string[];
    let driverSteps: DriverStep[] | undefined;
    // Teardown is deferred until after tracing stops + counters are snapshotted, so it
    // never inflates the measured counts.
    let runCleanup: (() => unknown | Promise<unknown>) | undefined;
    let cdpBefore: Record<string, number>;
    // Set only when the timed phase was split: the counter snapshot taken right after the first
    // timed iteration, which becomes this pass's authoritative `after` so the counts describe one
    // iteration instead of --iterations of them.
    let countsAfter: Record<string, number> | undefined;
    let cpuProfile: RawCpuProfile | undefined;
    const cpuIntervalUs = opts.cpuIntervalUs ?? DEFAULT_CPU_INTERVAL_US;

    if (opts.driver) {
      if (spec.categories && caps.trace) await page.tracing.start({ categories: spec.categories });
      if (spec.cpu && client && caps.cpuProfile) await startCpuProfile(client, cpuIntervalUs);
      // runDriver snapshots cdpBefore at run:start (after prepare()), so setup DOM work stays
      // out of the authoritative counts (consistent with bench mode below).
      // absModule is import()ed in Node, so it may live anywhere. A driver module outside root
      // just won't resolve through makeSourceResolver (which keys off the served-url prefix),
      // so its own frames stay unresolved; the page's frames are unaffected.
      const driverResult = await runDriver(page, client, absModule, opts.fn, {
        iterations: spec.iterations ?? opts.iterations,
        warmup: opts.warmup,
      });
      cdpBefore = driverResult.cdpBefore;
      // Same contract as the bench split: the overall counts describe the first timed iteration,
      // so they mean the same at any --iterations. runDriver closes the bracket itself (its
      // counter reads already happen in Node, so unlike bench there is nothing to split).
      if (spec.bracketFirstIteration && caps.cdpCounts)
        countsAfter = driverResult.cdpAfterFirstIteration;
      driverSteps = driverResult.steps;
      lifecycle = driverResult.lifecycle;
      perIteration = driverResult.steps.map((step) => step.wallMs);
      runCleanup = driverResult.cleanup;
    } else {
      const passIterations = spec.iterations ?? opts.iterations;
      const harnessArg = {
        // Bench mode only: the module is import()ed INSIDE the page, so it must be servable.
        // Driver mode imports it in Node (see runDriver above) and needs no url.
        moduleUrl: toServedUrl(server, root, absModule),
        fnName: opts.fn,
        iterations: passIterations,
        warmup: opts.warmup,
      };
      // prepare() + warmup run BEFORE the CDP snapshot / tracing so their layout/style
      // work isn't folded into the authoritative counts (warmup especially would inflate
      // them and disagree with the trace-window-scoped forced/paint counts).
      const setup = await page.evaluate(runHarness, { ...harnessArg, phase: "setup" as const });
      lifecycle = setup.lifecycle;
      cdpBefore = await snapshot();
      if (spec.categories && caps.trace) await page.tracing.start({ categories: spec.categories });
      if (spec.cpu && client && caps.cpuProfile) await startCpuProfile(client, cpuIntervalUs);
      // Counts must mean the same thing at --iterations 1 and 50, so the CDP counters bracket the
      // FIRST timed iteration alone rather than the whole loop. The counters are read from Node,
      // so the only way to close that bracket mid-loop is to return from page.evaluate: hence the
      // split. Skipped at one iteration (nothing to split), on lanes without CDP counters
      // (Firefox), and on passes that are their own count source (see bracketFirstIteration).
      const splitCounts = !!spec.bracketFirstIteration && passIterations > 1 && caps.cdpCounts;
      const first = await page.evaluate(runHarness, {
        ...harnessArg,
        phase: "timed" as const,
        iterations: splitCounts ? 1 : passIterations,
        offset: 0,
        runEnd: !splitCounts,
      });
      perIteration = first.perIteration;
      if (splitCounts) {
        // Closes the counts bracket. The gap costs one CDP round trip between iteration 0 and 1;
        // per-iteration wall is measured in-page, so the samples themselves are unaffected.
        countsAfter = await snapshot();
        const rest = await page.evaluate(runHarness, {
          ...harnessArg,
          phase: "timed" as const,
          iterations: passIterations - 1,
          offset: 1,
          runStart: false,
        });
        perIteration = perIteration.concat(rest.perIteration);
      }
      runCleanup = () => page.evaluate(runHarness, { ...harnessArg, phase: "cleanup" as const });
    }

    // Let asynchronous paint/composite work flush before we stop tracing.
    await sleep(opts.settleMs);

    if (spec.cpu && client && caps.cpuProfile) cpuProfile = await stopCpuProfile(client);

    let events: NormalizedEvent[] = [];
    let windowStart: number | null = null;
    let windowEnd: number | null = null;
    let stepWindows: LabelledWindow[] | undefined;
    if (spec.categories && caps.trace) {
      const buf = await page.tracing.stop();
      events = parseTrace(buf ? new TextDecoder("utf-8").decode(buf) : "[]", {
        keepThreadIds: spec.keepThreadIds,
      });
      // Rewrite trace stack urls back to local source files for blame/source lookup.
      await attachStacks(events, server.url, root, maps);
      // Flag forced (synchronous) layout/style: the layout-thrashing signal.
      markForced(events);
      const runWindow = findWindow(events);
      windowStart = runWindow.startTs;
      windowEnd = runWindow.endTs;
      // Re-key this pass's windows from index to label immediately: the index is only meaningful
      // inside the pass that produced it, and both sides are right here.
      if (opts.driver && driverSteps) stepWindows = labelWindows(driverSteps, findSteps(events));
    }

    // A split phase already closed the bracket after iteration 0; reuse it rather than snapshot
    // again, so `delta === after - before` holds and the metrics block describes one coherent
    // window. Unsplit, this is the post-settle snapshot.
    const cdpAfter = countsAfter ?? (await snapshot());

    // Teardown now; tracing is stopped and both counters are captured, so cleanup work
    // stays out of the measured window (the after-screenshot still shows post-cleanup).
    if (runCleanup) await runCleanup();

    if (shots?.after) {
      const screenshotPath = path.join(shots.dir, `${shots.base}.${spec.name}.after.png`);
      await page.screenshot({ path: screenshotPath as `${string}.png` });
      screenshots.after = screenshotPath;
    }

    const entries = (await page.evaluate(() => {
      const markEntries = performance
        .getEntriesByType("mark")
        .map((entry) => ({ name: entry.name, startTime: entry.startTime }));
      const measureEntries = performance.getEntriesByType("measure").map((entry) => ({
        name: entry.name,
        startTime: entry.startTime,
        duration: entry.duration,
      }));
      return { marks: markEntries, measures: measureEntries };
    })) as { marks: TimingEntry[]; measures: TimingEntry[] };

    result = {
      name: spec.name,
      events,
      windowStart,
      windowEnd,
      cdpBefore,
      cdpAfter,
      cdpDelta: metricsDelta(cdpBefore, cdpAfter),
      perIteration,
      lifecycle,
      marks: entries.marks,
      measures: entries.measures,
      screenshots: shots ? screenshots : undefined,
      driverSteps,
      stepWindows,
      cpuProfile,
    };
  } finally {
    // Closing Firefox flushes the Gecko shutdown dump, so the parse below must run after this.
    await browser.close();
  }

  // Firefox: parse the shutdown dump into the same shapes the Chrome path produces. One gecko
  // pass yields BOTH the CPU samples (RawCpuProfile) and layout/style blame events (from Reflow/
  // Styles markers). The run window comes from the wpd:run UserTiming marks inside the profile.
  if (spec.gecko && geckoDumpPath) {
    // Parse from a scoped string so the dump (potentially hundreds of MB) is collectable once
    // the model is built; the artifact is copied straight from the file by the caller.
    const geckoContext = parseGecko(JSON.parse(await waitForGeckoDump(geckoDumpPath)));
    result.geckoDumpPath = geckoDumpPath;
    result.cpuProfile = geckoToRawCpuProfile(geckoContext);
    // The interval the sampler actually ran at, not what we asked for.
    result.cpuSampleIntervalUs = geckoContext.intervalMs * US_PER_MS;
    const renderingEvents = geckoToRenderingEvents(geckoContext);
    await attachStacks(renderingEvents, server.url, root, maps);
    markForced(renderingEvents);
    result.events = renderingEvents;
    const geckoWindow = findWindow(renderingEvents);
    result.windowStart = geckoWindow.startTs;
    result.windowEnd = geckoWindow.endTs;
    if (opts.driver && result.driverSteps)
      result.stepWindows = labelWindows(result.driverSteps, findSteps(renderingEvents));
  }
  return result;
}

/**
 * The renderer main thread's pid/tid, plus how it was picked: `marker` when `wpd:run:start` (the
 * mark the page makes on its own main thread) named the thread, `heuristic` when that marker was
 * missing and the thread carrying the most layout/paint work stood in. A lost marker degrades to a
 * heuristic rather than to nothing; null when no candidate exists at all.
 */
function mainThread(
  events: NormalizedEvent[],
): { pid: number; tid: number; via: "marker" | "heuristic" } | null {
  const start = events.find((event) => event.name === "wpd:run:start");
  if (start?.pid != null && start.tid != null)
    return { pid: start.pid, tid: start.tid, via: "marker" };
  const activity = new Map<string, { pid: number; tid: number; count: number }>();
  for (const event of events) {
    if (event.pid == null || event.tid == null) continue;
    if (event.kind !== "layout" && event.kind !== "paint") continue;
    const key = `${event.pid}/${event.tid}`;
    const entry = activity.get(key) ?? { pid: event.pid, tid: event.tid, count: 0 };
    entry.count++;
    activity.set(key, entry);
  }
  let best: { pid: number; tid: number; count: number } | null = null;
  for (const entry of activity.values()) if (!best || entry.count > best.count) best = entry;
  return best ? { pid: best.pid, tid: best.tid, via: "heuristic" } : null;
}

/** Pair user `performance.measure` async begin/end trace events (blink.user_timing, ph b/e) into
 * named windows. wpd's own `wpd:*` measures are excluded -- the run/step spans come from marks, not
 * here. A repeated name (measured once per --iteration) keeps its FIRST in-window pair. */
export function userMeasureSpans(
  events: NormalizedEvent[],
  runStart: number,
  runEnd: number,
): { label: string; startTs: number; endTs: number }[] {
  const begins = new Map<string, number[]>();
  const out = new Map<string, { label: string; startTs: number; endTs: number }>();
  for (const event of events) {
    if (event.kind !== "usertiming" || event.name.startsWith("wpd:")) continue;
    if (event.ph === "b") {
      const list = begins.get(event.name) ?? [];
      list.push(event.ts);
      begins.set(event.name, list);
    } else if (event.ph === "e") {
      const list = begins.get(event.name);
      const startTs = list?.shift();
      if (startTs == null) continue;
      const endTs = event.ts;
      if (out.has(event.name)) continue;
      if (startTs < runStart || endTs > runEnd || endTs <= startTs) continue;
      out.set(event.name, { label: event.name, startTs, endTs });
    }
  }
  return [...out.values()];
}

/**
 * Build one seven-slice breakdown per span (--breakdown mode). Spans are the run window, each driver
 * step window, and every user `performance.measure` inside the run window. Durations come from the
 * main-thread trace events; the js slice is subdivided from the CPU samples projected onto the same
 * trace clock (they share Chrome's base::TimeTicks). Returns [] if no run window was found.
 */
async function buildBreakdowns(
  events: NormalizedEvent[],
  raw: RawCpuProfile,
  runWindow: { startTs: number | null; endTs: number | null },
  mergedSteps: MergedStep[] | undefined,
  context: { serverUrl: string; root: string; maps: SourceMapResolver; notes: string[] },
): Promise<SpanBreakdown[]> {
  if (runWindow.startTs == null || runWindow.endTs == null) return [];
  const main = mainThread(events);
  if (!main) return [];
  // The marker path names the page's own main thread; the heuristic only guesses from where the
  // rendering work landed, so another thread doing more layout/paint would steal the attribution.
  if (main.via === "heuristic")
    context.notes.push(
      "WARNING: the wpd:run:start marker was not found, so the breakdown's main thread was picked by layout/paint activity (heuristic). Per-span breakdown attribution may be on the wrong thread.",
    );
  const mainEvents = events.filter(
    (event) => event.pid === main.pid && event.tid === main.tid && event.dur > 0,
  );

  // Project every sample onto the trace clock: absolute ts = startTime + cumulative timeDeltas.
  const packagesByNode = await packagesByProfileNode(raw, context);
  const samples: BreakdownSample[] = [];
  let clock = raw.startTime;
  for (let index = 0; index < raw.samples.length; index++) {
    clock += raw.timeDeltas[index] ?? 0;
    samples.push({ ts: clock, package: packagesByNode.get(raw.samples[index]) ?? null });
  }

  const spans: { label: string; kind: SpanBreakdown["kind"]; startTs: number; endTs: number }[] = [
    { label: "run", kind: "run", startTs: runWindow.startTs, endTs: runWindow.endTs },
  ];
  for (const step of mergedSteps ?? []) {
    // A step whose end marker was lost runs to the end of the run window rather than being dropped.
    if (step.startTs == null) continue;
    spans.push({
      label: step.label,
      kind: "step",
      startTs: step.startTs,
      endTs: step.endTs ?? runWindow.endTs,
    });
  }
  for (const measure of userMeasureSpans(events, runWindow.startTs, runWindow.endTs))
    spans.push({
      label: measure.label,
      kind: "measure",
      startTs: measure.startTs,
      endTs: measure.endTs,
    });

  const breakdowns: SpanBreakdown[] = [];
  for (const span of spans) {
    const windowEvents = mainEvents.filter(
      (event) => event.ts < span.endTs && event.ts + event.dur > span.startTs,
    );
    const windowSamples = samples.filter(
      (sample) => sample.ts >= span.startTs && sample.ts <= span.endTs,
    );
    breakdowns.push({
      label: span.label,
      kind: span.kind,
      breakdown: computeSpanBreakdown(windowEvents, windowSamples, {
        startTs: span.startTs,
        endTs: span.endTs,
      }),
    });
  }
  return breakdowns;
}

export async function record(opts: RecordOptions): Promise<{
  recording: Recording;
  outPath: string;
  digestPath: string;
  indexPath?: string;
  cpuProfilePath?: string;
  cpuModelPath?: string;
  cpuModel?: CpuModel;
}> {
  const root = process.cwd();
  const absModule = path.resolve(opts.module);
  await fs.access(absModule).catch(() => {
    throw new Error(`Module not found: ${absModule}`);
  });

  const browserName: BrowserName = opts.browser ?? "chrome";
  const mode: "module" | "html" | "url" = opts.url ? "url" : opts.html ? "html" : "module";

  const outPath = opts.out
    ? path.resolve(opts.out)
    : path.resolve(
        "recordings",
        `${new Date().toISOString().replace(/[:.]/g, "-")}${extFor(opts.format)}`,
      );
  const outDir = path.dirname(outPath);
  const base = path.basename(outPath, path.extname(outPath));
  await fs.mkdir(outDir, { recursive: true });

  const wantBefore = opts.screenshot === "before" || opts.screenshot === "both";
  const wantAfter = opts.screenshot === "after" || opts.screenshot === "both";

  // Pass isolation: heavy invalidationTracking distorts timing, so measure timing
  // in a tracing-free pass and the paint/invalidation detail in a separate pass.
  const wantTrace = opts.trace !== false;
  const traceCats = traceCategories({ invalidationTracking: opts.invalidationTracking !== false });
  const traceSpec: PassSpec = { name: "trace", categories: traceCats };
  // The sampler rides the timing pass rather than a pass of its own: both specs are
  // `categories: null`, so a separate cpu pass would differ from the timing pass only by the
  // sampler and would buy isolation from the *timing* pass, which is not what matters.
  // What matters is isolation from TRACING. NEVER move `cpu` onto traceSpec: sampling there
  // inflates CPU self-time +21% with non-overlapping ranges, because `devtools.timeline.stack`
  // makes Blink walk the JS stack on every Layout and the sampler bills that work to the JS frame
  // that forced it -- landing on the same frame as the real forced-layout cost, so the two are
  // indistinguishable after the fact. Riding the timing pass costs ~10% on wall (already the
  // directional signal), which --no-cpu-profile buys back. Measurements: docs/dev/cpu-profiling.md.
  const timingSpec: PassSpec = {
    name: "timing",
    categories: null,
    cpu: opts.cpuProfile,
    bracketFirstIteration: true,
  };
  // --breakdown fuses a light trace (no `.stack`, no invalidationTracking) with the CPU sampler in
  // ONE pass, so trace events and samples share a clock and the seven-slice breakdown reconciles.
  // [measured] the light trace leaves self-time clean (+0-1%) and costs ~2-5% wall (probes A-C).
  // It carries wall AND counts like --no-isolate, so it does NOT bracket the first iteration (that
  // would put one iteration's CDP counts beside the whole-window trace counts); noteCountScope
  // includes the "breakdown" pass in its totalling set, so it discloses that counts total across
  // --iterations. keepThreadIds so the engine can pick the main thread.
  const breakdownSpec: PassSpec = {
    name: "breakdown",
    categories: breakdownTraceCategories(),
    cpu: true,
    keepThreadIds: true,
  };
  // --no-trace skips the heavy trace pass entirely: counts come from CDP (timing
  // pass) and optionally a CPU profile, with no paint/forced/invalidation detail.
  // The fallback for pages whose invalidationTracking pass pins the main thread.
  let specs: PassSpec[];
  if (opts.breakdown) {
    // Chrome-only single pass (the CLI rejects firefox/node and the contradictory isolation flags).
    specs = [breakdownSpec];
  } else if (browserName === "firefox") {
    // Firefox has no CDP trace/counters: a clean timing pass, plus one
    // Gecko-profiler pass that yields CPU samples AND layout/style markers (blame) together.
    // The gecko pass keeps --iterations (unlike Chrome's trace pass, pinned to 1 below): it is
    // also the only CPU sampler on this lane, and one iteration would starve it of samples.
    // Counts therefore still scale with --iterations here; noteBenchCountScope says so.
    specs = [timingSpec];
    if (opts.cpuProfile) specs.push({ name: "gecko", categories: null, gecko: true });
  } else {
    // No cpu pass: the sampler rides timingSpec (see the note there).
    // The trace pass is pinned to one iteration ONLY when a timing pass exists to carry the wall
    // samples. Under --no-isolate it is the only pass, so it has to run them all, and its counts
    // scale with --iterations again (disclosed, not silently wrong).
    specs = opts.isolate
      ? wantTrace
        ? [timingSpec, { ...traceSpec, iterations: 1 }]
        : [timingSpec]
      : wantTrace
        ? [traceSpec]
        : [timingSpec];
  }

  const server = await startStaticServer(root);
  // One resolver for the whole run: every pass's stack resolution and the CPU model share its
  // cache (a remote script + map is fetched once, not once per pass) and its diagnostics, so
  // `maps.diagnostics()` below sees every script the run tried to map.
  const maps = new SourceMapResolver();
  const results: PassResult[] = [];
  try {
    for (let index = 0; index < specs.length; index++) {
      // capture screenshots only once (first pass)
      const shots =
        index === 0 && (wantBefore || wantAfter)
          ? { before: wantBefore, after: wantAfter, dir: outDir, base }
          : null;
      results.push(await runPass(server, root, specs[index], opts, mode, absModule, shots, maps));
    }
  } finally {
    await server.close();
  }

  const timing = results.find((pass) => pass.name === "timing") ?? results[0];
  const detail =
    results.find((pass) => pass.name === "trace") ??
    results.find((pass) => pass.name === "gecko") ??
    results[results.length - 1];
  const screenshots = results.find((pass) => pass.screenshots)?.screenshots;

  // Merge the passes' steps HERE, before anything is written. mergeSteps rejects a flow whose
  // passes disagree, and that rejection has to happen before the recording, the digest and the
  // `latest` pointer exist: a run that failed after writing artifacts but before repointing
  // `latest` would leave `assert latest` silently gating the PREVIOUS run instead.
  // Pair by LABEL: the two passes are separate browser runs with independent step counters, so
  // their indices are not comparable. A detail pass with no run window found nothing to pair with
  // (no tracing on this lane, or the markers were lost); that is absence, reported by the
  // traceWindowMissing note below, so pass undefined rather than an empty list, which would read
  // as divergence.
  const mergedSteps =
    opts.driver && timing.driverSteps?.length
      ? mergeSteps(timing.driverSteps, detail.windowStart == null ? undefined : detail.stepWindows)
      : undefined;

  // The pass whose profile feeds the CPU model AND (in breakdown mode) the per-span bars. Found
  // here, before the notes, so the breakdown notes describe bars that were actually produced.
  const cpuPass = results.find((pass) => pass.cpuProfile);

  const notes: string[] = [];
  if (opts.breakdown && !cpuPass?.cpuProfile) {
    // The fused pass yielded no sampler profile, so buildBreakdowns produces nothing. Do NOT emit
    // the breakdown-mode notes below: they describe bars this run did not compute.
    notes.push(
      "WARNING: --breakdown could not be computed: the fused pass produced no CPU sampler profile, so no per-span breakdown was generated.",
    );
  } else if (opts.breakdown) {
    // The seven-slice breakdown is the product here; state its shape and, loudly, what a light trace
    // structurally cannot measure so a 0 is never read as clean.
    notes.push(
      "Breakdown mode: ONE fused pass (light trace + CPU sampler) yields a reconciling js/style/layout/paint/gc/other/idle bar per span (Σ slices + idle = wall). Timing rides this pass, so per-iteration wall is ~2-5% above a pristine timing pass.",
    );
    notes.push(
      "NOT measured in breakdown mode: forced-layout count and forced-layout blame (they need the `.stack` trace category, which this mode drops); reported as 'not measured', never 0. Run the default mode (no --breakdown) for forced-layout blame.",
    );
    notes.push(
      "NOT measured in breakdown mode: invalidation counts (layout/style/paint), because the invalidationTracking category is dropped. A 0 there means unmeasured, not clean. Layout/style/paint counts, long tasks, and CPU self-time ARE measured.",
    );
  } else if (browserName === "firefox") {
    notes.push(
      "Firefox backend (WebDriver BiDi): no CDP, so no exact counters and no CPU/network throttling. Wall timing rides performance.now (directional).",
    );
    // The counts are NOT simply absent on Firefox: with a gecko pass, summarize falls back to
    // counting Reflow/Styles markers, so layoutCount/styleCount/forcedLayoutCount carry real
    // numbers. Saying "not measured" would hide a working signal; leaving them unqualified would
    // invite diffing them against Chrome's CDP counts, which count a differently-batched thing.
    // Name which fields are real, which are a hard 0, and what the real ones may be compared to.
    notes.push(
      opts.cpuProfile
        ? "Rendering counts on Firefox: layoutCount/styleCount/forcedLayoutCount ARE measured, from the Gecko profiler's Reflow/Styles markers. Gecko batches layout differently than Chrome, so these are approximate and NOT comparable to Chrome's CDP counts: read them against another Firefox run. NOT measured at all and reported as 0: paintCount, invalidation counts, long tasks (counted from the DevTools trace, which Gecko has no equivalent of), and scriptingMs. A 0 in those means unmeasured, not clean."
        : // Unreachable from the CLI (it errors on --target firefox --no-cpu-profile); a
          // programmatic caller passing cpuProfile:false can still land here.
          "Rendering counts on Firefox come from the Gecko profiler pass, which this run disabled (cpuProfile:false). EVERY rendering count here is reported as 0 because nothing counted them, not because the page did no work: layout/style/paint, forced layout, invalidations, long tasks, scriptingMs. Wall timing and INP are real.",
    );
    // INP is deliberately NOT in the caps list above: it never came from CDP. It is the same
    // in-page Event Timing observer Chrome uses, so it works here; the honest caveat is that the
    // two engines' numbers are not interchangeable, not that Firefox cannot measure it.
    notes.push(
      "INP IS measured on Firefox (in-page Event Timing, the same observer Chrome uses). The two engines' values are not interchangeable: both span the interaction through the next paint and round to 8 ms, but Firefox reports a systematically lower number for identical work because presentation delay differs by engine. Compare a browser against itself across a change, not one engine against the other.",
    );
    // The js/browser/gc/idle breakdown is not emitted on Firefox; the [measured] rationale lives at
    // the omission site (buildCpuModel in profile/cpuprofile.ts). This is the user-facing note.
    notes.push(
      "No CPU time breakdown (js/browser/gc/idle bar) on Firefox: the Gecko profile does not record idle samples (a fully-idle window reads as 0 idle), so a bar here would fabricate the idle slice. CPU self-time (scriptingMs, query cpu) is still measured. Use --target chrome for the breakdown.",
    );
  } else {
    // Describe the pass plan that was actually BUILT, never the flags that were asked for. Those
    // diverge: `--no-isolate --no-trace` leaves one clean timing pass, so branching on
    // `opts.isolate` would announce "invalidationTracking was active during timing, so timings are
    // inflated" about a run with tracing off and timings that are fine. Reading `specs` cannot
    // drift from reality the way a second transcription of the flag logic can.
    const timingPass = specs.find((spec) => spec.name === "timing");
    const tracePass = specs.find((spec) => spec.name === "trace");
    // The measured-timing pass is whichever pass the summary's wall times came from.
    const timingIsTraced = !timingPass;

    notes.push(
      timingIsTraced
        ? "Single-pass mode (--no-isolate): instrumentation was active during timing, so per-iteration timings are inflated. Drop --no-isolate for trustworthy timing."
        : "Timing/stats come from a low-overhead pass with tracing OFF.",
    );
    notes.push(
      tracePass
        ? "Paint & invalidation counts come from a separate heavy-instrumentation pass; do not compare durations across the two."
        : "No trace pass ran (--no-trace): counts come from CDP only. Paint, forced-layout, invalidation and long-task detail is NOT collected and is reported as 0 — that means unmeasured, not clean.",
    );
    if (timingPass?.cpu) {
      notes.push(
        "The CPU sampler ran during the timing pass, which inflates per-iteration wall by roughly 10%: it is systematic, so it cancels in `diff`, but use --no-cpu-profile for absolute wall numbers.",
      );
    }
    // The sampler must not ride the trace pass (it would inflate self-time ~21%; see the timingSpec
    // note), so a plan with no timing pass has no CPU model. Say so: silently dropping it would
    // read as "this run had no JS worth sampling".
    if (opts.cpuProfile && !timingPass) {
      notes.push(
        "No CPU model in this run: --no-isolate collapses to the single trace pass, and CPU sampling during tracing would inflate self-time by ~21% (trace instrumentation is billed to the JS frame that triggered it). Drop --no-isolate to get a CPU model, or add --no-trace to sample without tracing.",
      );
    }
  }
  const countScope = noteCountScope(specs, opts, capsFor(browserName));
  if (countScope) notes.push(countScope);
  if (opts.cpuThrottle || opts.network) {
    notes.push(
      `Artificial slowdown applied (${[opts.cpuThrottle ? `cpu ${opts.cpuThrottle}x` : null, opts.network].filter(Boolean).join(", ")}); timings are not comparable to an unthrottled run.`,
    );
  }
  // The trace pass ran but its run-window markers are absent (truncated/overflowed trace
  // buffer, or the user_timing category got dropped). Without a window, inWindow() would count
  // the ENTIRE trace (page load, nav, prepare, teardown) as the measured region, silently
  // inflating every trace-derived count by an order of magnitude while looking normal. Treat
  // those counts as not-measured (0) and say so loudly; CDP counters are unaffected.
  // Firefox has its own honest notes (above) and no DevTools trace, so this Chrome-specific
  // trace-buffer warning does not apply there. Nor does it apply under --no-trace: no trace pass
  // ran, so a missing window is the flag working, not a buffer overflow. Telling that user to
  // "raise --settle because the trace buffer overflowed" sends them to debug a pass they turned
  // off; the --no-trace note above already states what is unmeasured.
  const traceWindowMissing = detail.windowStart == null && browserName !== "firefox" && wantTrace;
  if (traceWindowMissing) {
    notes.push(
      "WARNING: trace run-window markers (wpd:run:start/end) were not found, so paint/forced-layout/invalidation/long-task counts are NOT measured for this run and are reported as 0. CDP counters (layout/style/scripting) are unaffected. This usually means the trace buffer overflowed or the user_timing category was dropped; re-run, and reduce work or raise --settle if it persists.",
    );
  }

  const throttle =
    opts.cpuThrottle || opts.network
      ? { cpuRate: opts.cpuThrottle, network: opts.network }
      : undefined;

  const meta: RecordingMeta = {
    tool: TOOL,
    version: VERSION,
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    mode,
    target: mode === "url" ? opts.url! : mode === "html" ? opts.html! : opts.module,
    fn: opts.fn,
    iterations: opts.iterations,
    warmup: opts.warmup,
    headless: opts.headless,
    userDataDir: shorterPath(root, opts.userDataDir),
    lifecycle: detail.lifecycle,
    passes: results.map((pass) => pass.name),
    notes,
    driver: opts.driver,
    // Omit on Chrome so existing recordings are unchanged; readers default absent => "chrome".
    browser: browserName === "firefox" ? "firefox" : undefined,
    blameSemantic: blameSemanticFor(specs),
    throttle,
    screenshots,
  };

  // Last resort for an in-page run whose harness reported no samples (e.g. run() threw after the
  // marks landed): the wpd:run marks span the timed loop on the clean pass.
  const wallFromMarks = (): number | null => {
    const start = timing.marks.find((entry) => entry.name === "wpd:run:start")?.startTime;
    const end = timing.marks.find((entry) => entry.name === "wpd:run:end")?.startTime;
    return start != null && end != null ? end - start : null;
  };
  // Bench wall is the time actually spent in run(), summed over every timed iteration.
  //
  // It cannot be the detail pass's window: that pass runs a SINGLE iteration (counts describe one
  // iteration's work), so its window would report one iteration's wall as if it were all of them,
  // and `assert --max-wall 12` would pass a run it should fail. The wpd:run marks span the whole
  // loop and would work, but the split puts a CDP round trip inside that window (measured: 16.30 vs
  // 14.10 at 8 iterations, so ~2.1ms of the tool's own overhead billed to the page).
  //
  // Summing the samples avoids both: they are measured in-page around run() alone, on the pass
  // with tracing off, and they are the exact samples `stats` describes -- so the headline and the
  // distribution cannot disagree.
  const benchWallMs = (): number | null =>
    timing.perIteration.length
      ? timing.perIteration.reduce((total, iterationMs) => total + iterationMs, 0)
      : null;
  // A driver run has NO run-level wall, deliberately: there is no honest number to put here.
  //
  //   - The detail pass's window is measured with full tracing on, and the two-pass split exists
  //     precisely so that no reported time comes from the traced pass. It is also pinned to one
  //     iteration, so it would be a single traced sample sitting beside per-step medians of
  //     --iterations clean ones.
  //   - The timing pass's marks are clean, but they span prepare + every step + inter-step driver
  //     overhead + the settle sleep, which is no interaction anyone ran, and is ~90% settle floor
  //     plus input dispatch (docs/dev/driver-timing.md).
  //
  // A driver step's wall lives on the step (StepIndexEntry.wallMs, median of its samples); what the
  // PAGE did lives in `interaction` and the counts. `assert --max-wall` on a driver recording fails
  // loudly (assert.ts) and names the step index, rather than gating CI on a number that describes
  // the tool.
  const runWallMs = !opts.driver ? (benchWallMs() ?? wallFromMarks()) : null;
  // Overall INP = the worst STEP, where each step is its own median across iterations.
  //
  // Read off mergedSteps, not timing.driverSteps: the latter holds one entry per measureStep call
  // per iteration, so maxing it takes the worst sample of the worst step, and INP would climb with
  // --iterations on unchanged code (more samples, more chances at a slow one). Measured: that reads
  // summary.inpMs 56 while every step's median is 24, i.e. the recording contradicting its own step
  // index, and `assert --max-inp` getting stricter the more confidence you asked for. "Worst
  // interaction" must mean worst interaction, not worst outlier.
  const worstStep = (mergedSteps ?? []).reduce<MergedStep | null>(
    (worst, step) =>
      step.inpMs != null && (worst?.inpMs == null || step.inpMs > worst.inpMs) ? step : worst,
    null,
  );
  const overallInp = worstStep?.inpMs ?? null;
  // The breakdown comes from the SAME step as the headline, not from a max across steps: input
  // delay from one step and processing from another would describe an interaction nobody had.
  const overallInteraction = worstStep?.interaction ?? null;

  const recording: Recording = {
    meta,
    window: {
      measure: "wpd:run",
      startTs: detail.windowStart,
      endTs: detail.windowEnd,
      wallMs: runWallMs,
    },
    marks: timing.marks,
    metrics: { before: timing.cdpBefore, after: timing.cdpAfter, delta: timing.cdpDelta },
    events: detail.events,
    summary: buildSummary({
      // perIteration is bench-only: it feeds computeStats, which is only meaningful over
      // repetitions of the SAME work. Driver steps are heterogeneous ("mount" vs "inp"), so
      // their walls go to perStep instead and are never summarized into a median.
      perIteration: opts.driver ? [] : timing.perIteration,
      // From the timing pass (tracing off): clean, uninstrumented walls. One sample per step per
      // --iterations, grouped by label in mergeSteps, which is the only place that knows a
      // repeated label is a repetition rather than a collision. buildSummary derives the stats;
      // never pass a statistic in from here.
      perStep:
        mergedSteps?.map((step) => ({ label: step.label, perIteration: step.perIteration })) ?? [],
      // In-page (bench/node): the summed timed samples. Driver: null on purpose; see runWallMs.
      wallMs: runWallMs,
      inpMs: overallInp,
      interaction: overallInteraction,
      // No window => not measured (see traceWindowMissing note); don't count the whole trace.
      detailEvents: traceWindowMissing ? [] : detail.events,
      detailWindowStart: detail.windowStart,
      cdpDelta: timing.cdpDelta,
      // --breakdown drops the `.stack` category, so forced layout cannot be detected: report null,
      // not a fake 0. Every other mode measured it.
      forcedMeasured: !opts.breakdown,
    }),
  };

  // CPU profile: write the raw .cpuprofile (for DevTools/Speedscope) + a resolved,
  // self-contained model the query/cpu-diff verbs read. server.url is still valid here
  // (the server object is closed but its url string is captured for frame rewriting).
  // Built BEFORE any artifact is serialized: it resolves the last of the run's frames, so
  // meta.sourcemaps below is only complete once it has run, and `meta` is shared by reference
  // with every artifact written after this point.
  let cpuProfilePath: string | undefined;
  let cpuModelPath: string | undefined;
  let cpuModel: CpuModel | undefined;
  if (cpuPass?.cpuProfile) {
    if (cpuPass.geckoDumpPath) {
      // Firefox: the authoritative raw artifact is the Gecko dump (loads at profiler.firefox.com);
      // CpuModel.profile points at it. The model is built from the converted V8-shaped profile.
      // Copy rather than round-trip through a string: the dump can be very large.
      cpuProfilePath = path.join(outDir, `${base}.geckoprofile.json`);
      await fs.copyFile(cpuPass.geckoDumpPath, cpuProfilePath);
      await fs.rm(cpuPass.geckoDumpPath, { force: true });
    } else {
      cpuProfilePath = path.join(outDir, `${base}.cpuprofile`);
      await fs.writeFile(cpuProfilePath, JSON.stringify(cpuPass.cpuProfile), "utf8");
    }
    cpuModel = await buildCpuModel(cpuPass.cpuProfile, {
      profilePath: cpuProfilePath,
      meta,
      // Firefox reports the interval the Gecko sampler actually ran at; V8 honours what we asked for.
      sampleIntervalUs:
        cpuPass.cpuSampleIntervalUs ?? opts.cpuIntervalUs ?? DEFAULT_CPU_INTERVAL_US,
      serverUrl: server.url,
      root,
      maps,
    });
  }

  // --breakdown: one reconciling seven-slice breakdown per span (run, driver steps, user measures).
  // Built here because it needs both the trace events (with pid/tid) and the raw CPU samples, and
  // it shares the run's one resolver so a sample's package matches `query cpu --by package`.
  if (opts.breakdown && cpuPass?.cpuProfile) {
    recording.breakdowns = await buildBreakdowns(
      detail.events,
      cpuPass.cpuProfile,
      { startTs: detail.windowStart, endTs: detail.windowEnd },
      mergedSteps,
      { serverUrl: server.url, root, maps, notes },
    );
  }

  // Every frame the run will ever resolve has now been resolved, so the tally is final. A failed
  // map is otherwise silent: frames keep their minified names and bundle path, and per-package CPU
  // numbers look plausible while attributing everything to the bundle. Mutating `meta` here (not
  // at construction) is what lets every artifact below carry the same verdict.
  const sourcemaps = maps.diagnostics();
  // ALWAYS record the diagnostics when any script was attempted: the trace pass resolves stacks
  // through this same resolver, so `blame`'s source attribution depends on it just as `query cpu`
  // does. Gating the data on a CPU model existing would silently drop the only evidence a
  // --no-cpu-profile run has about its own blame.
  if (sourcemaps.scripts > 0) meta.sourcemaps = sourcemaps;
  // The NOTE is CPU-worded ("query cpu --by package"), so it needs a model to be about anything;
  // and it returns null when a missing map cost nothing at all.
  if (sourcemaps.scripts > 0 && cpuModel) {
    const note = sourcemapNote(sourcemaps, cpuModel.unmappedFrames ?? 0);
    if (note) notes.push(note);
  }

  await fs.writeFile(outPath, serialize(recording, opts.format), "utf8");
  if (cpuModel && cpuProfilePath) {
    cpuModelPath = path.join(outDir, `${base}.cpu${extFor(opts.format)}`);
    await fs.writeFile(cpuModelPath, serialize(cpuModel, opts.format), "utf8");
  }

  // Small, context-friendly entry point that points back into the big file by id.
  const digestPath = path.join(outDir, `${base}.digest${extFor(opts.format)}`);
  const digest = buildDigest(recording, outPath, 20);
  await fs.writeFile(digestPath, serialize(digest, opts.format), "utf8");

  // Driver/stepped runs: split the report into one file per step + an index.
  let indexPath: string | undefined;
  if (mergedSteps) {
    const ext = extFor(opts.format);
    const steps = mergedSteps;

    const entries: StepIndexEntry[] = [];
    for (const step of steps) {
      const evs = detail.events.filter(
        (event) =>
          step.startTs != null &&
          event.ts >= step.startTs &&
          (step.endTs == null || event.ts <= step.endTs),
      );
      const stepRec: Recording = {
        meta: { ...meta, step: { index: step.index, label: step.label } },
        window: {
          measure: `wpd:step:${step.index}`,
          startTs: step.startTs,
          endTs: step.endTs,
          wallMs: step.wallMs,
        },
        marks: [],
        metrics: { before: {}, after: {}, delta: step.cdpDelta },
        events: evs,
        summary: buildSummary({
          wallMs: step.wallMs,
          inpMs: step.inpMs,
          interaction: step.interaction,
          detailEvents: evs,
          detailWindowStart: step.startTs,
          cdpDelta: step.cdpDelta,
          // This step's own repetitions, so a per-step recording carries the same samples+stats
          // contract as a bench one: `wallMs` is their median, `stats` their spread.
          perIteration: step.perIteration,
          forcedMeasured: !opts.breakdown,
        }),
      };
      const stepBase = `${base}.step-${step.index}-${slug(step.label)}`;
      const stepRecPath = path.join(outDir, `${stepBase}${ext}`);
      const stepDigestPath = path.join(outDir, `${stepBase}.digest${ext}`);
      await fs.writeFile(stepRecPath, serialize(stepRec, opts.format), "utf8");
      await fs.writeFile(
        stepDigestPath,
        serialize(buildDigest(stepRec, stepRecPath, 10), opts.format),
        "utf8",
      );
      const summary = stepRec.summary;
      entries.push({
        index: step.index,
        label: step.label,
        wallMs: step.wallMs,
        stats: summary.stats,
        inpMs: step.inpMs,
        interaction: step.interaction,
        headline: {
          layoutCount: summary.layoutCount,
          forcedLayoutCount: summary.forcedLayoutCount,
          paintCount: summary.paintCount,
          layoutInvalidations: summary.layoutInvalidations,
          styleInvalidations: summary.styleInvalidations,
          longTaskCount: summary.longTaskCount,
        },
        recording: stepRecPath,
        digest: stepDigestPath,
      });
    }

    const index: StepIndex = {
      meta,
      recording: outPath,
      steps: entries,
      hints: [
        "Entry point for a stepped run. Inspect a step's digest, then drill into its recording.",
        `Per-step digest: wpd query digest "${entries[0]?.recording ?? "<step file>"}"`,
        `Layout thrashing in a step: wpd query blame --forced "${entries[0]?.recording ?? "<step file>"}"`,
        `Gate in CI: wpd assert "${indexPathHint(outDir, base, ext)}" --max-forced 0`,
      ],
    };
    indexPath = path.join(outDir, `${base}.index${ext}`);
    await fs.writeFile(indexPath, serialize(index, opts.format), "utf8");
  }

  // Pointer so `query/assert/diff … latest` resolve reliably (not by mtime).
  await writePointer({
    recording: outPath,
    digest: digestPath,
    index: indexPath,
    cpuProfile: cpuProfilePath,
    cpuModel: cpuModelPath,
  });

  return { recording, outPath, digestPath, indexPath, cpuProfilePath, cpuModelPath, cpuModel };
}

/** Terminal report for a --target node run: CPU headline + per-iteration timing, no DOM tables. */
function printNodeReport(result: {
  recording: Recording;
  outPath: string;
  digestPath: string;
  cpuProfilePath: string;
  cpuModelPath: string;
  cpuModel: CpuModel;
}): void {
  const meta = result.recording.meta;
  console.log(`\n${bold(meta.tool)} — node:${meta.target}  ${dim(`(fn: ${meta.fn})`)}`);
  printCpuHeadline(result.cpuModel);
  printCpuBreakdown(result.cpuModel);

  const stats = result.recording.summary.stats;
  const perIteration = result.recording.summary.perIteration;
  if (stats && perIteration.length > 1) {
    console.log("\nPer-iteration wall time\n");
    console.log(
      kv([
        ["samples", stats.samples],
        ["min ms", num(stats.minMs, 3)],
        ["median ms", num(stats.medianMs, 3)],
        ["mean ms", num(stats.meanMs, 3)],
        ["max ms", num(stats.maxMs, 3)],
      ]),
    );
    console.log(`trend  ${cyan(sparkline(perIteration))}`);
  }

  console.log(`\nRecording:  ${dim(displayPath(result.outPath))}`);
  console.log(
    `Digest:     ${dim(`${displayPath(result.digestPath)}  ← CPU-only run; rendering metrics are not collected`)}`,
  );
  console.log(
    `CPU model:  ${dim(`${displayPath(result.cpuModelPath)}  ← 'query cpu latest' for the hot-function overview`)}`,
  );
  console.log(
    `CPU raw:    ${dim(`${displayPath(result.cpuProfilePath)}  ← opens in Chrome DevTools / Speedscope`)}`,
  );
}

/**
 * One line qualifying the package table above it: can that table be believed?
 *
 * Silent when a missing map cost nothing — plain unbundled source needs none, and claiming
 * "packages below are minified bundles" about a hand-written `.mjs` whose frames resolved to their
 * own source file is simply false. Same trigger as sourcemapNote(); see the reasoning there.
 */
function printSourcemapLine(
  diagnostics: SourceMapDiagnostics | undefined,
  unmappedFrames: number,
): void {
  if (!diagnostics || diagnostics.scripts === 0) return;
  const unmappedBundles = diagnostics.unmappedBundles ?? 0;
  if (unmappedBundles === 0 && unmappedFrames === 0) return;
  const { scripts, resolved } = diagnostics;
  const reasons = Object.keys(diagnostics.failed ?? {}).join(", ");
  const hint = unmappedBundles
    ? `${reasons} — ${unmappedBundles} unmapped bundle(s) below are minified, not real packages`
    : `${reasons} — ${unmappedFrames} unattributed frame(s) are bucketed by origin`;
  console.log(`Sourcemaps: ${dim(`${resolved}/${scripts} resolved  ← ${hint}`)}`);
}

export async function recordAndReport(opts: RecordOptions): Promise<void> {
  if (opts.runtime === "node") {
    const { recordNode } = await import("../runtime/node.js");
    const result = await recordNode(opts);
    printNodeReport(result);
    return;
  }
  const { recording, outPath, digestPath, indexPath, cpuProfilePath, cpuModelPath, cpuModel } =
    await record(opts);
  printSummary(recording);
  // When CPU profiling was requested, lead with its headline; the layout/paint summary
  // above is not the signal the user asked for (and its scripting-ms can read 0).
  if (cpuModel) {
    printCpuHeadline(cpuModel);
    // Directly under the package table, because it says whether that table can be believed.
    printSourcemapLine(recording.meta.sourcemaps, cpuModel.unmappedFrames ?? 0);
    // In --breakdown mode the seven-slice per-span bars replace the single profile-only bar.
    if (recording.breakdowns?.length) printSpanBreakdowns(recording.breakdowns);
    else printCpuBreakdown(cpuModel);
  }
  if (recording.meta.throttle) {
    const throttle = recording.meta.throttle;
    console.log(
      `\nslowdown: ${[throttle.cpuRate ? `cpu ${throttle.cpuRate}x` : null, throttle.network].filter(Boolean).join(", ")}`,
    );
  }
  console.log(`\nRecording:  ${dim(displayPath(outPath))}`);
  console.log(
    `Digest:     ${dim(`${displayPath(digestPath)}  ← small entry point; start here, then drill with 'query get'`)}`,
  );
  if (indexPath) {
    console.log(
      `Step index: ${dim(`${displayPath(indexPath)}  ← stepped run; one file per step listed here`)}`,
    );
  }
  // Both are written together (record() only sets cpuModelPath when it wrote a profile), but say so
  // rather than guarding on one and interpolating the other: that form prints the string
  // "undefined" if the invariant ever breaks, which is how a template literal hides a missing value.
  if (cpuModelPath && cpuProfilePath) {
    console.log(
      `CPU model:  ${dim(`${displayPath(cpuModelPath)}  ← 'query cpu latest' for the hot-function overview`)}`,
    );
    const rawHint =
      recording.meta.browser === "firefox"
        ? "opens at profiler.firefox.com"
        : "opens in Chrome DevTools / Speedscope";
    console.log(`CPU raw:    ${dim(`${displayPath(cpuProfilePath)}  ← ${rawHint}`)}`);
  }
  if (recording.meta.screenshots?.before)
    console.log(`Before png: ${dim(displayPath(recording.meta.screenshots.before))}`);
  if (recording.meta.screenshots?.after)
    console.log(`After png:  ${dim(displayPath(recording.meta.screenshots.after))}`);
}
