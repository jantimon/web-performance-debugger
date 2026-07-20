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
import { runDriver, type DriverStep, type PartialRun } from "../browser/driver.js";
import { applyCpuThrottle } from "../browser/throttle.js";
import { parseTrace, findWindow, findSteps, type StepWindow } from "../trace/parse.js";
import { labelWindows, type LabelledWindow } from "../trace/steps.js";
import { attachStacks } from "../trace/stacks.js";
import { startTrace, stopTrace } from "../trace/tracing.js";
import { SourceMapResolver } from "../trace/sourcemap.js";
import { markForced } from "../trace/analysis.js";
import { startCpuProfile, stopCpuProfile } from "../metrics/cdp.js";
import { DEFAULT_CPU_INTERVAL_US, type RawCpuProfile } from "../profile/cpuprofile.js";
import { usToMs, msToUs } from "../model/time.js";
import type { NormalizedEvent, TimingEntry } from "../model/recording.js";
import type { CaptureConfig } from "./capture.js";
import type { RecordOptions } from "../commands/record.js";

export interface PassResult {
  name: string;
  events: NormalizedEvent[];
  windowStart: number | null;
  windowEnd: number | null;
  perIteration: number[];
  lifecycle: string[];
  marks: TimingEntry[];
  measures: TimingEntry[];
  /** driver mode: per-step wall time + INP */
  driverSteps?: DriverStep[];
  /** driver mode: set when --keep-partial salvaged a run whose later iteration failed */
  partial?: PartialRun;
  /** driver mode: this pass's own trace windows, already re-keyed from index to label */
  stepWindows?: LabelledWindow[];
  /**
   * Which clock priced the driver steps' walls: "trace" (t1-t0 on the trace clock between the step
   * marks, --breakdown/--deep), "page" (the page's own performance.now() delta, the no-trace default
   * rung), or "none" (driver ran but no step produced a wall). Absent on non-driver passes.
   */
  stepWallClock?: "trace" | "page" | "none";
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
  /** Chrome reported the trace buffer dropped events (overflow). Drives a loud not-silent note. */
  traceDataLoss?: boolean;
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

/** The Gecko sampling interval for this run: the interval option is expressed in microseconds (the
 * V8 unit) and Gecko takes milliseconds, clamped up to its ~1ms floor by geckoEnv. Unset => the floor. */
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

/**
 * Upgrade each driver step's wall to the trace-clock window between its marks: `t1 - t0` on the
 * trace clock, which spans navigation and reconciles with the breakdown bar. Keyed by markIndex (the
 * step's `wpd:step:N` marks), the same join `labelWindows` uses. A step with no closed trace window
 * keeps whatever wall it had (its page-clock value). Mutates the steps in place.
 */
function applyTraceWall(driverSteps: DriverStep[], stepTraceWindows: StepWindow[]): void {
  const windowByMark = new Map(stepTraceWindows.map((window) => [window.index, window]));
  for (const step of driverSteps) {
    const window = windowByMark.get(step.markIndex ?? step.index);
    if (window && window.endTs != null) {
      step.wallMs = usToMs(window.endTs - window.startTs);
      step.wallClock = "trace";
    } else if (step.wallMs != null) {
      step.wallClock = "page";
    }
  }
}

/** Whether any step carries a wall (a page-clock value, or a trace upgrade); "none" earns the note. */
function stepWallClockFor(driverSteps: DriverStep[], traced: boolean): "trace" | "page" | "none" {
  if (traced) return "trace";
  return driverSteps.some((step) => step.wallMs != null) ? "page" : "none";
}

export async function runPass(
  server: StaticServer,
  root: string,
  spec: CaptureConfig,
  opts: RecordOptions,
  mode: "module" | "html" | "url",
  absModule: string | undefined,
  maps: SourceMapResolver,
): Promise<PassResult> {
  const browserName: BrowserName = opts.browser ?? "chrome";
  // No module = the built-in on-ramp flow (driver mode only). It skips the host-page pre-navigation
  // and instead navigates to the target INSIDE a "load" step, so the boot lands in the run window.
  const onramp = opts.driver && absModule == null;
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
    disableSandbox: opts.disableSandbox,
    gecko: geckoDumpPath
      ? { dumpPath: geckoDumpPath, intervalMs: geckoIntervalMs(opts) }
      : undefined,
  });
  let result: PassResult;
  try {
    if (opts.cpuThrottle && client && caps.throttle)
      await applyCpuThrottle(client, opts.cpuThrottle);

    // The target the built-in "load" step navigates to (on-ramp only): the live --url as-is, or the
    // served --html file. Computed before the pre-navigation so the same served-url check applies.
    const onrampNavigateUrl = onramp
      ? mode === "url"
        ? opts.url!
        : toServedUrl(server, root, path.resolve(opts.html!))
      : undefined;

    if (onramp) {
      // Start blank; the "load" step navigates to the target inside the run window, so the measured
      // window is the page's own cold boot rather than a host page loaded before it (module mode).
      await page.goto(`${server.url}/__wpd_blank__`, { waitUntil: "load" });
    } else if (mode === "html") {
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

    let perIteration: number[];
    let lifecycle: string[];
    let driverSteps: DriverStep[] | undefined;
    let partial: PartialRun | undefined;
    // Teardown is deferred until after tracing stops, so it never inflates the measured counts.
    let runCleanup: (() => unknown | Promise<unknown>) | undefined;
    let cpuProfile: RawCpuProfile | undefined;
    const cpuIntervalUs = opts.cpuIntervalUs ?? DEFAULT_CPU_INTERVAL_US;

    if (opts.driver) {
      if (spec.categories && caps.trace && client) await startTrace(client, spec.categories);
      // The CPU sampler opens right before the run mark, from inside runDriver (after prepare and
      // warmup), NOT here: it is not windowed after the fact, so starting it before prepare bills
      // setup's page-side JS to the run. The trace, which IS windowed to the run marks, may start
      // earlier. See runDriver's beforeRunWindow.
      const startProfiler =
        spec.cpu && client && caps.cpuProfile
          ? () => startCpuProfile(client, cpuIntervalUs)
          : undefined;
      // absModule is import()ed in Node, so it may live anywhere. A driver module outside root
      // just won't resolve through makeSourceResolver (which keys off the served-url prefix),
      // so its own frames stay unresolved; the page's frames are unaffected.
      const driverResult = await runDriver(
        page,
        absModule,
        opts.fn,
        { iterations: opts.iterations, warmup: opts.warmup, keepPartial: opts.keepPartial },
        onramp ? { navigateUrl: onrampNavigateUrl! } : undefined,
        startProfiler,
      );
      driverSteps = driverResult.steps;
      partial = driverResult.partial;
      lifecycle = driverResult.lifecycle;
      // Driver pass-level perIteration is unused (record.ts sums step samples instead), but keep it
      // a clean number[]: an unpriced (navigated) step contributes no sample.
      perIteration = driverResult.steps
        .map((step) => step.wallMs)
        .filter((wallMs): wallMs is number => wallMs != null);
      runCleanup = driverResult.cleanup;
    } else {
      // Bench mode always has a module (the on-ramp is driver-only; the CLI rejects --bench with no
      // module), so absModule is defined here; narrow it for toServedUrl.
      if (!absModule) throw new Error("Bench mode needs a module to import inside the page.");
      const harnessArg = {
        // Bench mode only: the module is import()ed INSIDE the page, so it must be servable.
        // Driver mode imports it in Node (see runDriver above) and needs no url.
        moduleUrl: toServedUrl(server, root, absModule),
        fnName: opts.fn,
        iterations: opts.iterations,
        warmup: opts.warmup,
      };
      // prepare() + warmup run BEFORE tracing so their layout/style work isn't folded into the
      // window-scoped forced/paint counts (warmup especially would inflate them).
      const setup = await page.evaluate(runHarness, { ...harnessArg, phase: "setup" as const });
      lifecycle = setup.lifecycle;
      if (spec.categories && caps.trace && client) await startTrace(client, spec.categories);
      if (spec.cpu && client && caps.cpuProfile) await startCpuProfile(client, cpuIntervalUs);
      // One timed page.evaluate over the whole loop: with no CDP counter bracket to close mid-loop,
      // there is nothing to split. Bench wall is the sum of these timed samples (record.ts).
      const timed = await page.evaluate(runHarness, {
        ...harnessArg,
        phase: "timed" as const,
      });
      perIteration = timed.perIteration;
      runCleanup = () => page.evaluate(runHarness, { ...harnessArg, phase: "cleanup" as const });
    }

    // Let asynchronous paint/composite work flush before we stop tracing.
    await sleep(opts.settleMs);

    if (spec.cpu && client && caps.cpuProfile) cpuProfile = await stopCpuProfile(client);

    let events: NormalizedEvent[] = [];
    let windowStart: number | null = null;
    let windowEnd: number | null = null;
    let stepWindows: LabelledWindow[] | undefined;
    let stepWallClock: "trace" | "page" | "none" | undefined;
    let traceDataLoss = false;
    if (spec.categories && caps.trace && client) {
      const trace = await stopTrace(client);
      if (trace.tooLargeToParse) {
        const mb = Math.round((trace.byteLength ?? 0) / 1e6);
        throw new Error(
          `The trace grew to ${mb}MB, past the ~512MB a single string can hold, so it cannot be ` +
            `parsed and no counts are available. --deep (.stack + invalidationTracking) is the ` +
            `heaviest trace; reduce the measured work (fewer steps per run, or scope the flow), or ` +
            `use --breakdown (a lighter trace) if you do not need forced-layout blame.`,
        );
      }
      traceDataLoss = trace.dataLossOccurred;
      events = parseTrace(trace.text, {
        keepThreadIds: spec.keepThreadIds,
      });
      // Rewrite trace stack urls back to local source files for blame/source lookup.
      await attachStacks(events, server.url, root, maps);
      // Flag forced (synchronous) layout/style: the layout-thrashing signal.
      markForced(events);
      const runWindow = findWindow(events);
      windowStart = runWindow.startTs;
      windowEnd = runWindow.endTs;
      // Re-key this pass's step windows from index to label; both sides come from this one pass.
      // The trace clock also prices each step's wall (t1-t0 between its marks): the honest window,
      // in place of the page-clock value the driver captured.
      if (opts.driver && driverSteps) {
        const stepTraceWindows = findSteps(events);
        applyTraceWall(driverSteps, stepTraceWindows);
        stepWindows = labelWindows(driverSteps, stepTraceWindows);
        stepWallClock = stepWallClockFor(driverSteps, true);
      }
    } else if (opts.driver && driverSteps) {
      // No trace on this rung: the step wall stays the page-clock delta the driver measured.
      stepWallClock = stepWallClockFor(driverSteps, false);
    }

    // Teardown now; tracing is stopped, so cleanup work stays out of the measured window.
    if (runCleanup) await runCleanup();

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
      name: spec.rung,
      events,
      windowStart,
      windowEnd,
      perIteration,
      lifecycle,
      marks: entries.marks,
      measures: entries.measures,
      driverSteps,
      partial,
      stepWindows,
      stepWallClock,
      cpuProfile,
      headlessFallback,
      traceDataLoss,
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
    // Gecko's Reflow/Styles markers carry the wpd:step windows too, on the profiler clock; price the
    // step walls off them, the same trace-clock upgrade the Chrome branch applies.
    if (opts.driver && result.driverSteps) {
      const stepTraceWindows = findSteps(renderingEvents);
      applyTraceWall(result.driverSteps, stepTraceWindows);
      result.stepWindows = labelWindows(result.driverSteps, stepTraceWindows);
      result.stepWallClock = stepWallClockFor(result.driverSteps, true);
    }
  }
  return result;
}
