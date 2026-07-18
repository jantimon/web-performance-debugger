import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchBrowser, GECKO_MIN_INTERVAL_MS } from "../browser/launch.js";
import { capsFor, type BrowserName } from "../browser/backend.js";
import type { StaticServer } from "../browser/server.js";
import {
  parseGecko,
  geckoToRawCpuProfile,
  geckoToRenderingEvents,
  geckoUserMeasures,
} from "../profile/gecko.js";
import type { GeckoMeasureWindow } from "../profile/gecko-breakdown.js";
import { runHarness } from "../browser/harness.js";
import { runDriver, type DriverStep } from "../browser/driver.js";
import { applyCpuThrottle, applyNetworkPreset } from "../browser/throttle.js";
import { parseTrace, findWindow, findSteps } from "../trace/parse.js";
import { labelWindows, type LabelledWindow } from "../trace/steps.js";
import { attachStacks } from "../trace/stacks.js";
import { SourceMapResolver } from "../trace/sourcemap.js";
import { markForced } from "../trace/analysis.js";
import {
  enableMetrics,
  snapshotMetricsIfAvailable,
  metricsDelta,
  startCpuProfile,
  stopCpuProfile,
} from "../metrics/cdp.js";
import { DEFAULT_CPU_INTERVAL_US, type RawCpuProfile } from "../profile/cpuprofile.js";
import { usToMs, msToUs } from "../model/time.js";
import type { NormalizedEvent, ScreenshotRefs, TimingEntry } from "../model/recording.js";
import type { PassSpec } from "./passplan.js";
import type { RecordOptions } from "../commands/record.js";

export interface PassResult {
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
  /** Firefox: user `performance.measure` windows (profiler µs clock) for the mark-bridge spans */
  geckoMeasures?: GeckoMeasureWindow[];
  /** WARNING when chrome-headless-shell was missing and the launch fell back to new-headless */
  headlessFallback?: string;
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
    ? Math.max(GECKO_MIN_INTERVAL_MS, usToMs(opts.cpuIntervalUs))
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

export async function runPass(
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
  const { browser, page, client, headlessFallback } = await launchBrowser({
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
      headlessFallback,
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
    result.cpuSampleIntervalUs = msToUs(geckoContext.intervalMs);
    // User performance.measure spans, for the mark-bridge per-span breakdowns (record.ts builds them).
    result.geckoMeasures = geckoUserMeasures(geckoContext);
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
