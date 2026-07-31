import { promises as fs, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchBrowser, GECKO_MIN_INTERVAL_MS } from "../browser/launch.js";
import { registerDisposer } from "../browser/disposers.js";
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
import { runDriver, type PartialRun } from "../browser/driver.js";
import { inspectBotWall } from "../browser/bot-wall.js";
import type { BotWallVerdict } from "./bot-wall.js";
import type { DriverStep } from "../model/driver-step.js";
import { applyCpuThrottle } from "../browser/throttle.js";
import { parseTrace, findWindow, findSteps, type StepWindow } from "../trace/parse.js";
import { labelWindows, type LabelledWindow } from "../trace/steps.js";
import { attachStacks } from "../trace/stacks.js";
import { startTrace, stopTrace } from "../trace/tracing.js";
import { deepEventLogWouldOverflow } from "../model/capture-mode.js";
import { deepEventLogOverflowError } from "./artifacts.js";
import { SourceMapResolver } from "../trace/sourcemap.js";
import { markForced } from "../trace/analysis.js";
import { mainThread } from "../trace/main-thread.js";
import { sampledForcedBlameEvents } from "../trace/sampled-blame.js";
import { startCpuProfile, stopCpuProfile } from "../metrics/cdp.js";
import { assembleTraceCpuProfile, windowTraceCpuProfile } from "../trace/profile-chunks.js";
import { DEFAULT_CPU_INTERVAL_US, type RawCpuProfile } from "../profile/cpuprofile.js";
import { usToMs, msToUs } from "../model/time.js";
import { attachTeardownFailure } from "../model/teardown.js";
import type { NormalizedEvent, TimingEntry } from "../model/recording.js";
import type { GeckoContext } from "../profile/gecko.js";
import type { CaptureConfig } from "./capture.js";
import type { RecordOptions } from "./options.js";

export interface PassResult {
  /** the capture-mode name this pass ran (e.g. "breakdown", "deep", "gecko") */
  name: string;
  /** the classified event log; empty in capture modes that store none */
  events: NormalizedEvent[];
  /** trace-clock start of the run window (us); null when the marks were not found */
  windowStart: number | null;
  /** trace-clock end of the run window (us); null when the marks were not found */
  windowEnd: number | null;
  /** each timed iteration's wall (ms), in order */
  perIteration: number[];
  /** the lifecycle hooks that were found and called */
  lifecycle: string[];
  /** the raw `wpd:*` timing marks the windows were located from */
  marks: TimingEntry[];
  /** the user `performance.measure` entries captured in the window */
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
   * capture mode), or "none" (driver ran but no step produced a wall). Absent on non-driver passes
   */
  stepWallClock?: "trace" | "page" | "none";
  /** raw V8 CPU sampling profile (only on the cpu pass) */
  cpuProfile?: RawCpuProfile;
  /** Firefox: temp path of the raw Gecko shutdown dump, copied verbatim to the
   * .geckoprofile.json artifact and removed. Kept as a path, not a string: the dump can be
   * hundreds of MB and holding it would pin that for the rest of the run */
  geckoDumpPath?: string;
  /** Firefox: deregister the signal-cleanup disposer for `geckoDumpPath`. record.ts calls it once it
   * has removed the temp (after the atomic copy), so a completed run leaves nothing registered; until
   * then a fatal signal unlinks the temp synchronously rather than orphaning it (disposers.ts) */
  geckoDumpRelease?: () => void;
  /** interval the CPU sampler actually ran at, read back from the profile itself */
  cpuSampleIntervalUs?: number;
  /** --breakdown only: the sampled read-site forced-layout blame log (step/measure edge marks + the
   * sampled Layout/RecalcStyles blame events, source-resolved and `forced`), stored as the recording's
   * event log so `query blame --forced` answers. Undefined when the trace carried no per-sample lines
   * (older Chrome), so the caller reports blame unavailable rather than empty-as-clean */
  sampledBlame?: NormalizedEvent[];
  /** Firefox: user `performance.measure` windows (profiler µs clock) for the mark-bridge spans */
  geckoMeasures?: GeckoMeasureWindow[];
  /** Chrome reported the trace buffer dropped events (overflow). Drives a loud not-silent note */
  traceDataLoss?: boolean;
  /** Bot-wall detection verdict for a wpd-performed navigation (onramp / --url host page). Present
   * only when it was detected AND --allow-bot-wall let the run continue (an undetected page and a
   * refused run both leave it undefined -- a refusal throws before the pass returns) */
  botWallVerdict?: BotWallVerdict;
  /** The browser build string this pass launched, verbatim from `browser.version()` (chrome
   * "Chrome/151.0.7922.47", firefox "Firefox/152.0"). Undefined when the backend could not report it.
   * buildMeta parses the milestone off it for the comparability axis */
  browserVersion?: string;
  /** The run-level framework-addon probe payload read off `window.__wpdAddons` at the end of the run
   * (keyed by addon name); undefined when no addon installed a page probe (--framework off) or the read
   * failed. An addon's enrich shapes it into `Span.addons`. Browser lanes only (node has no page) */
  addonPageData?: Record<string, unknown>;
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
 * ring buffer serializes to a multi-hundred-MB file on a slow disk */
const GECKO_DUMP_TIMEOUT_MS = 15_000;
/** Poll cadence while waiting for the dump. The dump is complete when `browser.close()` resolves
 * (puppeteer waits for process exit, and MOZ_PROFILER_SHUTDOWN writes during shutdown), so the poll
 * only confirms the file is on disk and settled; a tight cadence confirms that in a few reads */
const GECKO_DUMP_POLL_MS = 20;
/** Consecutive equal sizes that count as "done growing", guarding a slow-disk write that lands after
 * the first stat (the file exists but is still being flushed on a very large dump) */
const GECKO_DUMP_STABLE_READS = 3;

/** The Gecko sampling interval for this run: the interval option is expressed in microseconds (the
 * V8 unit) and Gecko takes milliseconds, clamped up to its ~1ms floor by geckoEnv. Unset => the floor */
function geckoIntervalMs(opts: RecordOptions): number {
  return opts.cpuIntervalUs != null
    ? Math.max(GECKO_MIN_INTERVAL_MS, usToMs(opts.cpuIntervalUs))
    : GECKO_MIN_INTERVAL_MS;
}

/** Firefox flushes the Gecko shutdown dump during `browser.close()`, so by the time this runs the
 * file is written; the poll confirms it exists AND has stopped growing (stable across reads) before
 * parsing, which only matters when a very large dump is still landing on a slow disk */
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
 * Wait for the Gecko shutdown dump, then parse it. If the wait or parse fails (a dump that never
 * lands, truncated JSON, a profile missing the JavaScript category) remove the temp dump before
 * re-throwing, so a broken dump leaves no orphaned 16MB+ file behind. On success the file is kept for
 * the caller to copy to the artifact
 */
export async function readGeckoDump(dumpPath: string): Promise<GeckoContext> {
  try {
    return parseGecko(JSON.parse(await waitForGeckoDump(dumpPath)));
  } catch (error) {
    await fs.rm(dumpPath, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Upgrade each driver step's wall to the trace-clock window between its marks: `t1 - t0` on the
 * trace clock, which spans navigation and reconciles with the breakdown bar. Keyed by markIndex (the
 * step's `wpd:step:N` marks), the same join `labelWindows` uses. A step with no closed trace window
 * keeps whatever wall it had (its page-clock value). Mutates the steps in place
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

/** Whether any step carries a wall (a page-clock value, or a trace upgrade); "none" earns the note */
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
  botWall?: { allow: boolean; screenshotPath: string },
  /** self-contained in-page install functions from the active framework addons; installed via
   * evaluateOnNewDocument BEFORE any navigation so a probe (e.g. the React hook) is present before app
   * code runs on every document. Empty when --framework off */
  addonPageInits: (() => void)[] = [],
): Promise<PassResult> {
  const browserName: BrowserName = opts.browser ?? "chrome";
  // No module = the built-in on-ramp flow (driver mode only). It skips the host-page pre-navigation
  // and instead navigates to the target INSIDE a "load" step, so the boot lands in the run window
  const onramp = opts.driver && absModule == null;
  const caps = capsFor(browserName);
  // Firefox: the Gecko pass profiles for its whole lifetime and dumps on exit; a fresh temp
  // file per pass keeps concurrent/retried runs from colliding
  const geckoDumpPath = spec.gecko
    ? path.join(
        os.tmpdir(),
        `wpd-gecko-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
      )
    : undefined;
  // On a fatal signal, unlink the gecko temp synchronously so a multi-hundred-MB dump is not left on
  // disk. Firefox writes it during browser.close(), so it may not exist yet when a signal lands; the
  // unlink is best-effort either way. Deregistered wherever the temp is removed the normal way; on the
  // success handoff the release travels to record.ts on PassResult (disposers.ts)
  const releaseGeckoDump = geckoDumpPath
    ? registerDisposer(() => {
        try {
          unlinkSync(geckoDumpPath);
        } catch {
          /* best-effort: the dump may not have been written, or already removed */
        }
      })
    : () => {};
  const { browser, page, client, release } = await launchBrowser({
    browser: browserName,
    headless: opts.headless,
    userDataDir: opts.userDataDir,
    protocolTimeoutMs: opts.protocolTimeoutMs,
    disableSandbox: opts.disableSandbox,
    gecko: geckoDumpPath
      ? { dumpPath: geckoDumpPath, intervalMs: geckoIntervalMs(opts) }
      : undefined,
  });
  let result: PassResult;
  // The launched browser's build string, for the comparability axis. Best-effort: a backend that
  // cannot report it leaves the axis unmeasured rather than failing the run
  const browserVersion = await browser.version().catch(() => undefined);
  // Bot-wall detection for a wpd-performed navigation. `inspect()` collects + classifies the settled
  // page; on a detected wall with no --allow-bot-wall it screenshots + throws (refusing before any
  // measurement pass), else it stores the verdict so a detected-but-allowed run can note it. Called for
  // the onramp (after the load step, via the driver hook), for a --url/--html host pre-navigation, and
  // for each hard navigation a driver module performs (via runDriver's onHardNavigation). A driver can
  // inspect several navigations, so keep the FIRST detected verdict rather than letting a later clean
  // navigation overwrite it (the loud note still fires under --allow-bot-wall)
  let botWallVerdict: BotWallVerdict | undefined;
  const inspect = botWall
    ? async () => {
        const verdict = await inspectBotWall(page, botWall);
        if (!botWallVerdict?.detected) botWallVerdict = verdict;
      }
    : undefined;
  try {
    // Install the active framework addons' in-page probes BEFORE any navigation, so a probe (e.g. the
    // React detection hook) is present before app code runs on every document (evaluateOnNewDocument
    // re-arms on each navigation). Best-effort per addon: a backend that cannot preload a script must
    // not fail the run (detection stays honestly absent instead). Also install on the current blank
    // document. See docs/dev/react-attribution.md
    for (const install of addonPageInits) {
      await page.evaluateOnNewDocument(install).catch(() => {});
      await page.evaluate(install).catch(() => {});
    }

    if (opts.cpuThrottle && client && caps.throttle)
      await applyCpuThrottle(client, opts.cpuThrottle);

    // The target the built-in "load" step navigates to (on-ramp only): the live --url as-is, or the
    // served local HTML file. Computed before the pre-navigation so the same served-url check applies
    const onrampNavigateUrl = onramp
      ? mode === "url"
        ? opts.url!
        : toServedUrl(server, root, path.resolve(opts.html!))
      : undefined;

    if (onramp) {
      // Start blank; the "load" step navigates to the target inside the run window, so the measured
      // window is the page's own cold boot rather than a host page loaded before it (module mode)
      await page.goto(`${server.url}/__wpd_blank__`, { waitUntil: "load" });
    } else if (mode === "html") {
      await page.goto(toServedUrl(server, root, path.resolve(opts.html!)), {
        waitUntil: "load",
        timeout: 30000,
      });
      // The host page is a wpd navigation, so inspect it (a --url pointed at a wall drives a wall)
      if (inspect) await inspect();
    } else if (mode === "url") {
      await page.goto(opts.url!, { waitUntil: "load", timeout: 30000 });
      if (inspect) await inspect();
    } else {
      // Same-origin blank page so the module import() below is not cross-origin
      await page.goto(`${server.url}/__wpd_blank__`, { waitUntil: "load" });
    }

    let perIteration: number[];
    let lifecycle: string[];
    let driverSteps: DriverStep[] | undefined;
    let partial: PartialRun | undefined;
    // Teardown is deferred until after tracing stops, so it never inflates the measured counts
    let runCleanup: (() => unknown | Promise<unknown>) | undefined;
    let cpuProfile: RawCpuProfile | undefined;
    // The interval the samples actually ran at, for the CPU model. In the trace-sourced --breakdown
    // capture mode it is read back from the ProfileChunk stream (a fixed rate we do not set); on the CDP
    // sampler it is what we requested
    let cpuSampleIntervalUs: number | undefined;
    const cpuIntervalUs = opts.cpuIntervalUs ?? DEFAULT_CPU_INTERVAL_US;
    // The --breakdown capture mode sources CPU samples from the trace's v8.cpu_profiler stream, so the CDP
    // profiler must NOT also run (one profiler at a time); the samples are assembled after stopTrace
    const cdpSampler = spec.cpu && spec.cpuSource === "cdp" && client != null && caps.cpuProfile;

    if (opts.driver) {
      if (spec.categories && caps.trace && client) await startTrace(client, spec.categories);
      // The CPU sampler opens right before the run mark, from inside runDriver (after prepare and
      // warmup), NOT here: it is not windowed after the fact, so starting it before prepare bills
      // setup's page-side JS to the run. The trace, which IS windowed to the run marks, may start
      // earlier. See runDriver's beforeRunWindow. The trace-sourced capture mode starts no CDP profiler
      const startProfiler =
        cdpSampler && client ? () => startCpuProfile(client, cpuIntervalUs) : undefined;
      // absModule is import()ed in Node, so it may live anywhere. A driver module outside root
      // just won't resolve through makeSourceResolver (which keys off the served-url prefix),
      // so its own frames stay unresolved; the page's frames are unaffected
      const driverResult = await runDriver(
        page,
        absModule,
        opts.fn,
        { iterations: opts.iterations, warmup: opts.warmup, keepPartial: opts.keepPartial },
        onramp ? { navigateUrl: onrampNavigateUrl!, afterFirstLoad: inspect } : undefined,
        startProfiler,
        // A user driver module's own page.goto is not covered by the onramp hook, so inspect each hard
        // navigation it performs. Only for a real module (the onramp's single load step is inspected by
        // afterFirstLoad above; passing both would double-inspect it)
        onramp ? undefined : inspect,
      );
      driverSteps = driverResult.steps;
      partial = driverResult.partial;
      lifecycle = driverResult.lifecycle;
      // Driver pass-level perIteration is unused (record.ts sums step samples instead), but keep it
      // a clean number[]: an unpriced (navigated) step contributes no sample
      perIteration = driverResult.steps
        .map((step) => step.wallMs)
        .filter((wallMs): wallMs is number => wallMs != null);
      runCleanup = driverResult.cleanup;
    } else {
      // Bench mode always has a module (the on-ramp is driver-only; the CLI rejects --bench with no
      // module), so absModule is defined here; narrow it for toServedUrl
      if (!absModule) throw new Error("Bench mode needs a module to import inside the page.");
      const harnessArg = {
        /**
         * Bench mode only: the module is import()ed INSIDE the page, so it must be servable
         * Driver mode imports it in Node (see runDriver above) and needs no url
         */
        moduleUrl: toServedUrl(server, root, absModule),
        fnName: opts.fn,
        iterations: opts.iterations,
        warmup: opts.warmup,
      };
      // prepare() + warmup run BEFORE tracing so their layout/style work isn't folded into the
      // window-scoped forced/paint counts (warmup especially would inflate them)
      const setup = await page.evaluate(runHarness, { ...harnessArg, phase: "setup" as const });
      lifecycle = setup.lifecycle;
      if (spec.categories && caps.trace && client) await startTrace(client, spec.categories);
      if (cdpSampler && client) await startCpuProfile(client, cpuIntervalUs);
      // One timed page.evaluate over the whole loop: with no CDP counter bracket to close mid-loop,
      // there is nothing to split. Bench wall is the sum of these timed samples (record.ts)
      const timed = await page.evaluate(runHarness, {
        ...harnessArg,
        phase: "timed" as const,
      });
      perIteration = timed.perIteration;
      runCleanup = () => page.evaluate(runHarness, { ...harnessArg, phase: "cleanup" as const });
    }

    // Read the run-level framework-addon probe payload off the final document before the browser
    // closes (detection metadata + cumulative commit count). Best-effort: a page that navigated away or
    // a failed read leaves it undefined, so detection stays honestly absent. Only when an addon
    // installed a probe
    let addonPageData: Record<string, unknown> | undefined;
    if (addonPageInits.length) {
      const raw = await page.evaluate(() => (window as any).__wpdAddons ?? null).catch(() => null);
      if (raw && typeof raw === "object") addonPageData = raw as Record<string, unknown>;
    }

    // Let asynchronous paint/composite work flush before we stop tracing. [measured] This trailing
    // settle is load-bearing for the counts, NOT dead time: a paint the flow defers past the first
    // frame (a double-`requestAnimationFrame`, a short `setTimeout`) lands in this window and is
    // counted only if the settle outlasts it -- ~50 ms catches a double-rAF/~30 ms tail, ~200 ms
    // catches a ~100 ms-deferred paint; drop the settle and those paints vanish from the counts. It
    // runs ONCE after the whole flow (not per iteration), so its cost is a fixed per-run tail. INP is
    // unaffected: the driver's per-step settle already finalizes the interaction before the step ends
    await sleep(opts.settleMs);

    if (cdpSampler && client) cpuProfile = await stopCpuProfile(client);

    let events: NormalizedEvent[] = [];
    let windowStart: number | null = null;
    let windowEnd: number | null = null;
    let stepWindows: LabelledWindow[] | undefined;
    let stepWallClock: "trace" | "page" | "none" | undefined;
    let traceDataLoss = false;
    // --breakdown only: the sampled read-site forced-layout blame log (the step/measure marks so a span
    // can window it, plus the sampled blame events). Undefined when the trace carried no per-sample
    // lines, so the caller can disclose that blame is unavailable rather than reading empty as "clean"
    let sampledBlame: NormalizedEvent[] | undefined;
    if (spec.categories && caps.trace && client) {
      const trace = await stopTrace(client);
      traceDataLoss = trace.dataLossOccurred;
      // Preflight (--deep only): the raw trace byte size is known the moment the stream completes, so
      // a --deep trace too heavy for its stored event log to serialize is refused HERE, before the
      // parse (which OOMs on a heavier trace at the default heap) can run. The writeRecording guard
      // stays the backstop. --breakdown stores no full event log, so it is not gated and parses past
      // the ceiling by design (docs/dev/trace-buffer.md)
      if (deepEventLogWouldOverflow(spec.mode, trace.bytes.length))
        throw deepEventLogOverflowError(trace.bytes.length);
      // Parse the trace one event at a time straight from the raw bytes (scanTraceEvents), so a heavy
      // --deep trace past the ~512MB single-string ceiling still parses and peak heap tracks the events
      // kept, not the whole raw array. --deep runs only this scan; --breakdown scans a second time below
      // for the CPU stream (a lighter trace, so the re-walk is cheap)
      events = parseTrace(trace.bytes, {
        keepThreadIds: spec.keepThreadIds,
      });
      // Rewrite trace stack urls back to local source files for blame/source lookup
      await attachStacks(events, server.url, root, maps);
      // Flag forced (synchronous) layout/style: the layout-thrashing signal
      markForced(events);
      const runWindow = findWindow(events);
      windowStart = runWindow.startTs;
      windowEnd = runWindow.endTs;
      // --breakdown sources CPU samples from the trace's v8.cpu_profiler ProfileChunk stream (no CDP
      // profiler ran). The stream runs for the whole trace, which in driver mode starts before
      // prepare()/warmup, so window it to the run onward: the CPU model must describe only the run,
      // the same run-mark scope the CDP sampler opens at in the other capture modes (bench starts the trace
      // after setup, so the filter is a no-op there). Null means the browser emitted no chunk stream:
      // leave cpuProfile undefined so the caller falls back to honest not-covered reporting, never a
      // fabricated zero profile
      if (spec.cpu && spec.cpuSource === "trace") {
        const assembled = assembleTraceCpuProfile(trace.bytes);
        if (assembled) {
          cpuProfile =
            windowStart != null
              ? windowTraceCpuProfile(assembled.profile, windowStart)
              : assembled.profile;
          cpuSampleIntervalUs = assembled.sampleIntervalUs;
          // Sampled read-site forced-layout blame from the per-sample executing lines, when the trace
          // carried them. The light trace has no `.stack`, so this is the ONLY read-site source here;
          // the samples keep sampling through a synchronous forced layout, so a flush window's sample
          // names the forcing line (docs/dev/blame-semantics.md). Absent sampleLines => leave
          // sampledBlame undefined so the caller reports blame unavailable, never empty-as-clean
          if (assembled.sampleLines) {
            const urlByNode = new Map(
              assembled.profile.nodes.map((node) => [node.id, node.callFrame.url ?? ""]),
            );
            // The leaf function's callFrame line+column (0-based CDP) per node: the resolver's
            // column-bearing fallback when a sample's executing line cannot be disambiguated on a
            // minified bundle, so the read still names the forcing function (the CPU-model frame)
            const frameByNode = new Map(
              assembled.profile.nodes.map((node) => [
                node.id,
                {
                  line: node.callFrame.lineNumber ?? -1,
                  column: node.callFrame.columnNumber ?? -1,
                },
              ]),
            );
            const blame = sampledForcedBlameEvents(
              events,
              {
                urlByNode,
                frameByNode,
                samples: assembled.profile.samples,
                timestampsUs: assembled.profile.sampleTimestampsUs ?? [],
                lines: assembled.sampleLines,
                threads: assembled.sampleThreads,
                intervalUs: assembled.sampleIntervalUs,
              },
              windowStart,
              mainThread(events),
            );
            // Resolve the sampled frame to local source (event.at) and mark it forced, the same path
            // the trace/gecko events take, so `query blame --forced` reads it identically
            await attachStacks(blame, server.url, root, maps);
            markForced(blame);
            // Store the run/step edge marks alongside so `query span <step>` can window the blame to a
            // step; a shallow copy keeps `events`' own ids intact. Ids are reassigned in ts order for
            // stable `query get <id>` addressing (parseTrace/gecko do the same)
            const marks = events
              .filter((event) => event.kind === "usertiming")
              .map((event) => ({ ...event }));
            const log = [...marks, ...blame].sort((left, right) => left.ts - right.ts);
            log.forEach((event, index) => {
              event.id = index;
            });
            sampledBlame = log;
          }
        }
      }
      // Re-key this pass's step windows from index to label; both sides come from this one pass
      // The trace clock also prices each step's wall (t1-t0 between its marks): the honest window,
      // in place of the page-clock value the driver captured
      if (opts.driver && driverSteps) {
        const stepTraceWindows = findSteps(events);
        applyTraceWall(driverSteps, stepTraceWindows);
        stepWindows = labelWindows(driverSteps, stepTraceWindows);
        stepWallClock = stepWallClockFor(driverSteps, true);
      }
    } else if (opts.driver && driverSteps) {
      // No trace in this capture mode: the step wall stays the page-clock delta the driver measured
      stepWallClock = stepWallClockFor(driverSteps, false);
    }

    // Teardown now; tracing is stopped, so cleanup work stays out of the measured window
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
      name: spec.mode,
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
      cpuSampleIntervalUs,
      sampledBlame,
      traceDataLoss,
      botWallVerdict,
      browserVersion,
      addonPageData,
    };
  } catch (runError) {
    // The run failed. Close the browser (which also flushes a Firefox shutdown dump) so nothing is
    // left running, but never let a close failure replace the run error: attach it as the cause
    // Then remove the now-orphaned Gecko dump, since the parse below is skipped, and re-throw
    try {
      await browser.close();
    } catch (closeError) {
      attachTeardownFailure(runError, closeError);
    }
    release();
    if (geckoDumpPath) {
      releaseGeckoDump();
      await fs.rm(geckoDumpPath, { force: true }).catch(() => {});
    }
    throw runError;
  }

  // The run succeeded. Close the browser, which flushes a Firefox shutdown dump, so the parse below
  // runs after this. A close failure here is the only error, so it surfaces; drop any orphaned dump
  try {
    await browser.close();
    release();
  } catch (closeError) {
    release();
    if (geckoDumpPath) {
      releaseGeckoDump();
      await fs.rm(geckoDumpPath, { force: true }).catch(() => {});
    }
    throw closeError;
  }

  // Firefox: parse the shutdown dump into the same shapes the Chrome path produces. One gecko
  // pass yields BOTH the CPU samples (RawCpuProfile) and layout/style blame events (from Reflow/
  // Styles markers). The run window comes from the wpd:run UserTiming marks inside the profile
  if (spec.gecko && geckoDumpPath) {
    // Parse from a scoped string so the dump (potentially hundreds of MB) is collectable once
    // the model is built; the artifact is copied straight from the file by the caller. readGeckoDump
    // removes the temp dump if the wait/parse fails, so drop its signal guard on that failure too
    let geckoContext: GeckoContext;
    try {
      geckoContext = await readGeckoDump(geckoDumpPath);
    } catch (readError) {
      releaseGeckoDump();
      throw readError;
    }
    try {
      result.geckoDumpPath = geckoDumpPath;
      // The temp now travels to record.ts (it copies then removes it); hand off the release with it
      result.geckoDumpRelease = releaseGeckoDump;
      result.cpuProfile = geckoToRawCpuProfile(geckoContext);
      // The interval the sampler actually ran at, not what we asked for
      result.cpuSampleIntervalUs = msToUs(geckoContext.intervalMs);
      // User performance.measure spans, for the mark-bridge per-span breakdowns (record.ts builds them)
      result.geckoMeasures = geckoUserMeasures(geckoContext);
      const renderingEvents = geckoToRenderingEvents(geckoContext);
      await attachStacks(renderingEvents, server.url, root, maps);
      markForced(renderingEvents);
      result.events = renderingEvents;
      const geckoWindow = findWindow(renderingEvents);
      result.windowStart = geckoWindow.startTs;
      result.windowEnd = geckoWindow.endTs;
      // Gecko's Reflow/Styles markers carry the wpd:step windows too, on the profiler clock; price the
      // step walls off them, the same trace-clock upgrade the Chrome branch applies
      if (opts.driver && result.driverSteps) {
        const stepTraceWindows = findSteps(renderingEvents);
        applyTraceWall(result.driverSteps, stepTraceWindows);
        result.stepWindows = labelWindows(result.driverSteps, stepTraceWindows);
        result.stepWallClock = stepWallClockFor(result.driverSteps, true);
      }
    } catch (geckoError) {
      // The converter or source resolution failed before the dump was handed to the caller for the
      // copy: remove the temp so a failure past the parse leaks nothing
      releaseGeckoDump();
      await fs.rm(geckoDumpPath, { force: true }).catch(() => {});
      throw geckoError;
    }
  }
  return result;
}
