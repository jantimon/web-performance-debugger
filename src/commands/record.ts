import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchBrowser } from "../browser/launch.js";
import { capsFor, type BrowserName } from "../browser/backend.js";
import { startStaticServer, type StaticServer } from "../browser/server.js";
import { parseGecko, geckoToRawCpuProfile, geckoToRenderingEvents } from "../profile/gecko.js";
import { runHarness } from "../browser/harness.js";
import { runDriver, type DriverStep } from "../browser/driver.js";
import { applyCpuThrottle, applyNetworkPreset } from "../browser/throttle.js";
import { traceCategories } from "../trace/categories.js";
import { parseTrace, findWindow, findSteps, type StepWindow } from "../trace/parse.js";
import { attachStacks } from "../trace/stacks.js";
import { markForced } from "../trace/analysis.js";
import {
  enableMetrics,
  snapshotMetrics,
  metricsDelta,
  startCpuProfile,
  stopCpuProfile,
} from "../metrics/cdp.js";
import { buildSummary } from "../metrics/summarize.js";
import { buildCpuModel, type RawCpuProfile } from "../profile/cpuprofile.js";
import { printCpuHeadline } from "./cpu.js";
import { printSummary } from "./summaryView.js";
import { kv, num, sparkline } from "../output/ascii.js";
import { bold, cyan, dim } from "../output/color.js";
import { buildDigest } from "./digest.js";
import { writePointer } from "./resolve.js";
import { serialize, extFor, type Format } from "../output/format.js";
import { VERSION, TOOL } from "../version.js";
import { SCHEMA_VERSION } from "../schema.js";
import type {
  CpuModel,
  NormalizedEvent,
  Recording,
  RecordingMeta,
  ScreenshotRefs,
  StepIndex,
  StepIndexEntry,
  TimingEntry,
} from "../model/recording.js";

const DEFAULT_CPU_INTERVAL_US = 50;

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
  /** also capture a V8 CPU sampling profile (writes .cpuprofile + .cpu model) */
  cpuProfile?: boolean;
  /** CPU sampler interval in microseconds (default 50) */
  cpuIntervalUs?: number;
  /** execution runtime: "chrome" (default, Puppeteer page) or "node" (in-process V8, CPU only) */
  runtime?: "chrome" | "node";
  /** CDP protocol timeout (ms); raise above the 180s default for heavy traced interactions */
  protocolTimeoutMs?: number;
  /** run the trace pass (default true); false = counts-only (CDP + optional CPU), no paint/forced/invalidation */
  trace?: boolean;
  /** include the invalidationTracking trace category (default true); false drops it to cut overhead on invalidation-heavy pages */
  invalidationTracking?: boolean;
}

interface PassSpec {
  name: string;
  /** null = run with tracing OFF (clean timing) */
  categories: string[] | null;
  /** capture a CPU sampling profile during this pass (tracing stays off) */
  cpu?: boolean;
  /** Firefox: run under the Gecko profiler; the shutdown dump yields CPU samples AND
   * layout/style markers (blame) from this one pass. */
  gecko?: boolean;
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
  /** driver mode: per-step trace windows (from the trace pass) */
  stepWindows?: StepWindow[];
  /** raw V8 CPU sampling profile (only on the cpu pass) */
  cpuProfile?: RawCpuProfile;
  /** Firefox: the raw Gecko shutdown dump JSON, written verbatim as the .geckoprofile.json artifact */
  geckoRawJson?: string;
}

/** A step merged across passes: label+timing from the timing pass, window from the trace pass. */
interface MergedStep {
  index: number;
  label: string;
  wallMs: number;
  inpMs: number | null;
  cdpDelta: Record<string, number>;
  startTs: number | null;
  endTs: number | null;
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Firefox writes the Gecko shutdown dump asynchronously after browser.close(); wait for the
 * file to exist AND stop growing (stable across reads) before parsing it. */
async function waitForGeckoDump(dumpPath: string, timeoutMs = 15000): Promise<string> {
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
      if (++stableReads >= 3) return fs.readFile(dumpPath, "utf8");
    } else {
      stableReads = 0;
    }
    lastSize = size;
    await sleep(250);
  }
  throw new Error(
    `Gecko profile dump was not written to ${dumpPath} within ${timeoutMs}ms (Firefox --cpu-profile pass).`,
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
    userDataDir: opts.userDataDir,
    protocolTimeoutMs: opts.protocolTimeoutMs,
    gecko: geckoDumpPath ? { dumpPath: geckoDumpPath } : undefined,
  });
  // On Firefox client is null; every CDP call is guarded by the caps object or this helper.
  const snapshot = (): Promise<Record<string, number>> =>
    client && caps.cdpCounts ? snapshotMetrics(client) : Promise.resolve({});
  const screenshots: ScreenshotRefs = {};
  let result: PassResult;
  try {
    if (client && caps.cdpCounts) await enableMetrics(client);
    if (opts.cpuThrottle && client && caps.throttle)
      await applyCpuThrottle(client, opts.cpuThrottle);
    if (opts.network && client && caps.throttle) await applyNetworkPreset(client, opts.network);

    const moduleUrl = toServedUrl(server, root, absModule);

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
    let cpuProfile: RawCpuProfile | undefined;
    const cpuIntervalUs = opts.cpuIntervalUs ?? DEFAULT_CPU_INTERVAL_US;

    if (opts.driver) {
      if (spec.categories && caps.trace) await page.tracing.start({ categories: spec.categories });
      if (spec.cpu && client) await startCpuProfile(client, cpuIntervalUs);
      // runDriver snapshots cdpBefore at run:start (after prepare()), so setup DOM work stays
      // out of the authoritative counts (consistent with bench mode below).
      const driverResult = await runDriver(page, client, absModule, opts.fn);
      cdpBefore = driverResult.cdpBefore;
      driverSteps = driverResult.steps;
      lifecycle = driverResult.lifecycle;
      perIteration = driverResult.steps.map((step) => step.wallMs);
      runCleanup = driverResult.cleanup;
    } else {
      const harnessArg = {
        moduleUrl,
        fnName: opts.fn,
        iterations: opts.iterations,
        warmup: opts.warmup,
      };
      // prepare() + warmup run BEFORE the CDP snapshot / tracing so their layout/style
      // work isn't folded into the authoritative counts (warmup especially would inflate
      // them and disagree with the trace-window-scoped forced/paint counts).
      const setup = await page.evaluate(runHarness, { ...harnessArg, phase: "setup" as const });
      lifecycle = setup.lifecycle;
      cdpBefore = await snapshot();
      if (spec.categories && caps.trace) await page.tracing.start({ categories: spec.categories });
      if (spec.cpu && client) await startCpuProfile(client, cpuIntervalUs);
      const timed = await page.evaluate(runHarness, { ...harnessArg, phase: "timed" as const });
      perIteration = timed.perIteration;
      runCleanup = () => page.evaluate(runHarness, { ...harnessArg, phase: "cleanup" as const });
    }

    // Let asynchronous paint/composite work flush before we stop tracing.
    await sleep(opts.settleMs);

    if (spec.cpu && client) cpuProfile = await stopCpuProfile(client);

    let events: NormalizedEvent[] = [];
    let windowStart: number | null = null;
    let windowEnd: number | null = null;
    let stepWindows: StepWindow[] | undefined;
    if (spec.categories && caps.trace) {
      const buf = await page.tracing.stop();
      events = parseTrace(buf ? new TextDecoder("utf-8").decode(buf) : "[]");
      // Rewrite trace stack urls back to local source files for blame/source lookup.
      await attachStacks(events, server.url, root);
      // Flag forced (synchronous) layout/style: the layout-thrashing signal.
      markForced(events);
      const runWindow = findWindow(events);
      windowStart = runWindow.startTs;
      windowEnd = runWindow.endTs;
      if (opts.driver) stepWindows = findSteps(events);
    }

    const cdpAfter = await snapshot();

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
    const rawJson = await waitForGeckoDump(geckoDumpPath);
    await fs.rm(geckoDumpPath, { force: true }).catch(() => {});
    const geckoContext = parseGecko(JSON.parse(rawJson));
    result.geckoRawJson = rawJson;
    result.cpuProfile = geckoToRawCpuProfile(geckoContext);
    const renderingEvents = geckoToRenderingEvents(geckoContext);
    await attachStacks(renderingEvents, server.url, root);
    markForced(renderingEvents);
    result.events = renderingEvents;
    const geckoWindow = findWindow(renderingEvents);
    result.windowStart = geckoWindow.startTs;
    result.windowEnd = geckoWindow.endTs;
    if (opts.driver) result.stepWindows = findSteps(renderingEvents);
  }
  return result;
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
  const timingSpec: PassSpec = { name: "timing", categories: null };
  // --no-trace skips the heavy trace pass entirely: counts come from CDP (timing
  // pass) and optionally a CPU profile, with no paint/forced/invalidation detail.
  // The fallback for pages whose invalidationTracking pass pins the main thread.
  let specs: PassSpec[];
  if (browserName === "firefox") {
    // Firefox has no CDP trace/counters: a clean timing pass, plus (only with --cpu-profile) one
    // Gecko-profiler pass that yields CPU samples AND layout/style markers (blame) together.
    specs = [timingSpec];
    if (opts.cpuProfile) specs.push({ name: "gecko", categories: null, gecko: true });
  } else {
    specs = opts.isolate
      ? wantTrace
        ? [timingSpec, traceSpec]
        : [timingSpec]
      : wantTrace
        ? [traceSpec]
        : [timingSpec];
    // CPU sampling is heavy, so it gets its own isolated pass (tracing stays off in it).
    if (opts.cpuProfile) specs.push({ name: "cpu", categories: null, cpu: true });
  }

  const server = await startStaticServer(root);
  const results: PassResult[] = [];
  try {
    for (let index = 0; index < specs.length; index++) {
      // capture screenshots only once (first pass)
      const shots =
        index === 0 && (wantBefore || wantAfter)
          ? { before: wantBefore, after: wantAfter, dir: outDir, base }
          : null;
      results.push(await runPass(server, root, specs[index], opts, mode, absModule, shots));
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

  const notes: string[] = [];
  if (browserName === "firefox") {
    notes.push(
      "Firefox backend (WebDriver BiDi): no CDP, so exact layout/style/script counts, paint counts, invalidation tracking, CPU/network throttling, and INP are NOT measured. Wall timing rides performance.now (directional). Layout/style blame comes from the Gecko profiler's Reflow/Styles markers and needs --cpu-profile.",
    );
    if (!opts.cpuProfile) {
      notes.push(
        "No --cpu-profile: this run captured wall timing only. Add --cpu-profile for source-attributed layout/style (Reflow/Styles markers) plus CPU self-time by package/file/function.",
      );
    }
  } else if (opts.isolate) {
    notes.push(
      "Timing/stats come from a low-overhead pass with tracing OFF; paint & invalidation counts come from a separate heavy-instrumentation pass. Do not compare durations across the two.",
    );
  } else {
    notes.push(
      "Single-pass mode: invalidationTracking instrumentation was active during timing, so per-iteration timings are inflated. Use --isolate (default) for trustworthy timing.",
    );
  }
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
  // trace-buffer warning does not apply there.
  const traceWindowMissing = detail.windowStart == null && browserName !== "firefox";
  if (traceWindowMissing) {
    notes.push(
      "WARNING: trace run-window markers (wpd:run:start/end) were not found, so paint/forced-layout/invalidation/long-task counts are NOT measured for this run and are reported as 0. CDP counters (layout/style/scripting) are unaffected. This usually means the trace buffer overflowed or the user_timing category was dropped; re-run, and reduce work or raise --settle-ms if it persists.",
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
    throttle,
    screenshots,
  };

  // Firefox timing-only runs have no trace/gecko window; fall back to the wpd:run marks
  // (performance.now ms) so wall time is still reported. Chrome behavior is untouched.
  const wallFromMarks = (): number | null => {
    const start = timing.marks.find((entry) => entry.name === "wpd:run:start")?.startTime;
    const end = timing.marks.find((entry) => entry.name === "wpd:run:end")?.startTime;
    return start != null && end != null ? end - start : null;
  };
  const runWallMs =
    detail.windowStart != null && detail.windowEnd != null
      ? (detail.windowEnd - detail.windowStart) / 1000
      : browserName === "firefox"
        ? wallFromMarks()
        : null;
  // overall INP = worst interaction across driver steps
  const overallInp =
    timing.driverSteps && timing.driverSteps.length
      ? timing.driverSteps.reduce<number | null>(
          (worst, step) =>
            step.inpMs != null && (worst == null || step.inpMs > worst) ? step.inpMs : worst,
          null,
        )
      : null;

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
      perIteration: opts.driver ? [] : timing.perIteration,
      // wallMs is the measured run window for both modes (was null for in-page, which
      // silently disabled `assert --max-wall`).
      wallMs: runWallMs,
      inpMs: overallInp,
      // No window => not measured (see traceWindowMissing note); don't count the whole trace.
      detailEvents: traceWindowMissing ? [] : detail.events,
      detailWindowStart: detail.windowStart,
      cdpDelta: timing.cdpDelta,
    }),
  };

  await fs.writeFile(outPath, serialize(recording, opts.format), "utf8");

  // Small, context-friendly entry point that points back into the big file by id.
  const digestPath = path.join(outDir, `${base}.digest${extFor(opts.format)}`);
  const digest = buildDigest(recording, outPath, 20);
  await fs.writeFile(digestPath, serialize(digest, opts.format), "utf8");

  // Driver/stepped runs: split the report into one file per step + an index.
  let indexPath: string | undefined;
  if (opts.driver && timing.driverSteps && timing.driverSteps.length) {
    const ext = extFor(opts.format);
    const windows = detail.stepWindows ?? [];
    const steps: MergedStep[] = timing.driverSteps.map((step) => {
      const stepWindow = windows.find((candidate) => candidate.index === step.index);
      return {
        index: step.index,
        label: step.label,
        wallMs: step.wallMs,
        inpMs: step.inpMs,
        cdpDelta: step.cdpDelta, // clean, from timing pass
        startTs: stepWindow?.startTs ?? null,
        endTs: stepWindow?.endTs ?? null,
      };
    });

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
          detailEvents: evs,
          detailWindowStart: step.startTs,
          cdpDelta: step.cdpDelta,
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
        inpMs: step.inpMs,
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

  // CPU profile: write the raw .cpuprofile (for DevTools/Speedscope) + a resolved,
  // self-contained model the query/cpu-diff verbs read. server.url is still valid here
  // (the server object is closed but its url string is captured for frame rewriting).
  let cpuProfilePath: string | undefined;
  let cpuModelPath: string | undefined;
  let cpuModel: CpuModel | undefined;
  const cpuPass = results.find((pass) => pass.cpuProfile);
  if (cpuPass?.cpuProfile) {
    if (cpuPass.geckoRawJson) {
      // Firefox: the authoritative raw artifact is the Gecko dump (loads at profiler.firefox.com);
      // CpuModel.profile points at it. The model is built from the converted V8-shaped profile.
      cpuProfilePath = path.join(outDir, `${base}.geckoprofile.json`);
      await fs.writeFile(cpuProfilePath, cpuPass.geckoRawJson, "utf8");
    } else {
      cpuProfilePath = path.join(outDir, `${base}.cpuprofile`);
      await fs.writeFile(cpuProfilePath, JSON.stringify(cpuPass.cpuProfile), "utf8");
    }
    cpuModel = await buildCpuModel(cpuPass.cpuProfile, {
      profilePath: cpuProfilePath,
      meta,
      // Gecko's sampling floor is ~1ms; the V8 default (50us) does not apply to the Firefox lane.
      sampleIntervalUs:
        browserName === "firefox" ? 1000 : (opts.cpuIntervalUs ?? DEFAULT_CPU_INTERVAL_US),
      serverUrl: server.url,
      root,
    });
    cpuModelPath = path.join(outDir, `${base}.cpu${extFor(opts.format)}`);
    await fs.writeFile(cpuModelPath, serialize(cpuModel, opts.format), "utf8");
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

/** Terminal report for a --runtime node run: CPU headline + per-iteration timing, no DOM tables. */
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

  console.log(`\nRecording:  ${dim(result.outPath)}`);
  console.log(
    `Digest:     ${dim(`${result.digestPath}  ← CPU-only run; rendering metrics are not collected`)}`,
  );
  console.log(
    `CPU model:  ${dim(`${result.cpuModelPath}  ← 'query cpu latest' for the hot-function overview`)}`,
  );
  console.log(
    `CPU raw:    ${dim(`${result.cpuProfilePath}  ← opens in Chrome DevTools / Speedscope`)}`,
  );
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
  if (cpuModel) printCpuHeadline(cpuModel);
  if (recording.meta.throttle) {
    const throttle = recording.meta.throttle;
    console.log(
      `\nslowdown: ${[throttle.cpuRate ? `cpu ${throttle.cpuRate}x` : null, throttle.network].filter(Boolean).join(", ")}`,
    );
  }
  console.log(`\nRecording:  ${dim(outPath)}`);
  console.log(
    `Digest:     ${dim(`${digestPath}  ← small entry point; start here, then drill with 'query get'`)}`,
  );
  if (indexPath) {
    console.log(`Step index: ${dim(`${indexPath}  ← stepped run; one file per step listed here`)}`);
  }
  if (cpuModelPath) {
    console.log(
      `CPU model:  ${dim(`${cpuModelPath}  ← 'query cpu latest' for the hot-function overview`)}`,
    );
    const rawHint =
      recording.meta.browser === "firefox"
        ? "opens at profiler.firefox.com"
        : "opens in Chrome DevTools / Speedscope";
    console.log(`CPU raw:    ${dim(`${cpuProfilePath}  ← ${rawHint}`)}`);
  }
  if (recording.meta.screenshots?.before)
    console.log(`Before png: ${dim(recording.meta.screenshots.before)}`);
  if (recording.meta.screenshots?.after)
    console.log(`After png:  ${dim(recording.meta.screenshots.after)}`);
}
