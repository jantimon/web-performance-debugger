import { promises as fs } from "node:fs";
import path from "node:path";
import type { HeadlessMode } from "../browser/launch.js";
import type { BrowserName } from "../browser/backend.js";
import { startStaticServer } from "../browser/server.js";
import { mergeSteps, type MergedStep } from "../trace/steps.js";
import { mainThread } from "../trace/main-thread.js";
import { retryTransientNav } from "../browser/launch.js";
import { SourceMapResolver } from "../trace/sourcemap.js";
import { buildSummary } from "../metrics/summarize.js";
import {
  buildCpuModel,
  packagesByProfileNode,
  toDevtoolsCpuProfile,
  DEFAULT_CPU_INTERVAL_US,
} from "../profile/cpuprofile.js";
import { buildGeckoSpanBreakdowns } from "../profile/gecko-breakdown.js";
import {
  captureFor,
  capabilitiesAfterParse,
  capabilitiesFor,
  blameSemanticFor,
  countScopeNote,
} from "../record/capture.js";
import { runPass, type PassResult } from "../record/runpass.js";
import { buildBreakdowns, userMeasureSpans } from "../record/breakdown-spans.js";
import { buildRecordingSpans } from "../record/spans-build.js";
import { writeRecording, writeCpuModel } from "../record/artifacts.js";
import * as notesCatalog from "../record/notes.js";
import { RUN_START_MARK, RUN_END_MARK, RUN_MEASURE } from "../model/marks.js";
import { printCpuHeadline, printCpuBreakdown, printSpanBreakdowns } from "./cpu.js";
import { printSummary } from "./summaryView.js";
import { kv, num, sparkline } from "../output/ascii.js";
import { bold, cyan, dim } from "../output/color.js";
import { writePointer, displayPath } from "./resolve.js";
import { extFor, type Format } from "../output/format.js";
import { VERSION, TOOL } from "../version.js";
import { SCHEMA_VERSION } from "../schema.js";
import { stableWorkloadPath } from "../model/compat.js";
import type {
  CpuModel,
  Recording,
  RecordingMeta,
  SourceMapDiagnostics,
  SourceMapFailure,
  SpanBreakdown,
} from "../model/recording.js";

// The capture ladder, the seven-slice span builder, and the artifact writers live in src/record/.
// record.ts stays the orchestrator: it wires the one pass, mutates `meta` in the one load-bearing
// order, and drives the writers. These re-exports keep the compiled dist surface stable for the
// tests and programmatic consumers that import them from this module.
export { blameSemanticFor, countScopeNote, userMeasureSpans };

export interface RecordOptions {
  /** the user's driver/bench/node module; omitted for the built-in on-ramp flow (--url/--html only) */
  module?: string;
  fn: string;
  /** browser backend: "chrome" (default, full CDP) or "firefox" (BiDi + Gecko profiler) */
  browser?: BrowserName;
  html?: string;
  url?: string;
  /** --url named a host with no scheme, so http:// was assumed for `url`; a note discloses it. */
  urlSchemeAssumed?: boolean;
  iterations: number;
  warmup: number;
  out?: string;
  headless: boolean;
  /** chrome headless flavour: "shell" (default, ~120Hz frames) or "new"; ignored when headed/firefox */
  headlessMode?: HeadlessMode;
  /** persistent Chrome profile dir (resolved absolute); reuse one login across passes/runs */
  userDataDir?: string;
  /** chrome only: launch with --no-sandbox (reduced containment). Off by default; opt in only in a
   * trusted, isolated environment. */
  disableSandbox?: boolean;
  /** ms to wait after run() for async paints to flush; internal default 200 (no user flag) */
  settleMs: number;
  format: Format;
  /** driver (puppeteer) mode: run executes in Node and receives { page, ctx } */
  driver: boolean;
  /** keep the iterations that completed when a later iteration fails, with a loud note (driver mode) */
  keepPartial?: boolean;
  /** artificial slowdown: CPU throttling multiplier (e.g. 4 = 4x slower) */
  cpuThrottle?: number;
  /** capture a CPU sampling profile (writes .cpuprofile + .cpu model); on by default, off on --deep
   * (the sampler cannot ride a `.stack` trace) and --precise-wall. */
  cpuProfile?: boolean;
  /** CPU sampler interval in microseconds (default DEFAULT_CPU_INTERVAL_US); internal, no user flag */
  cpuIntervalUs?: number;
  /** execution runtime: "chrome" (default, Puppeteer page) or "node" (in-process V8, CPU only) */
  runtime?: "chrome" | "node";
  /** CDP protocol timeout (ms); raise above the 180s default for heavy traced interactions */
  protocolTimeoutMs?: number;
  /**
   * The --breakdown capture mode (chrome only): a light trace (no `.stack`, no invalidationTracking)
   * fused with the CPU sampler in ONE pass, producing a reconciling js/style/layout/paint/gc/other/idle
   * bar per span. Cannot report forced-layout counts or blame (they need `.stack`).
   */
  breakdown?: boolean;
  /**
   * The --deep capture mode (chrome only): ONE full-trace pass (`.stack` + invalidationTracking) with
   * the sampler OFF. The attribution report -- exact forced-layout blame, invalidation rollup, exact
   * counts -- with slice durations suppressed (the `.stack` trace distorts them). No CPU model, no bar.
   */
  deep?: boolean;
  /** The default capture mode minus the sampler: a pristine benchmark wall, no profiler, no counts. */
  preciseWall?: boolean;
  /** Opt-in variant label stamped on meta, so a diff/cpu-diff gate refuses across two techniques
   * that run through one module path (env-switched). Absent by default. */
  variant?: string;
}

/** Bounded retries for a transient cross-process navigation failure (fresh browser each attempt). */
const NAV_RETRY_LIMIT = 2;

/** Persistent-profile path for meta: shorter of relative-to-root vs absolute, or null if unused. */
function shorterPath(root: string, absPath: string | undefined): string | null {
  if (!absPath) return null;
  const relative = path.relative(root, absPath);
  return relative && relative.length < absPath.length ? relative : absPath;
}

/** Plain-English remedy per failure reason, so the note says what to actually do. */
const SOURCEMAP_REMEDY: Record<SourceMapFailure, string> = {
  "no-sourcemap-url":
    "the bundle carries no sourceMappingURL comment and no SourceMap response header (many production builds strip both)",
  "script-fetch-failed": "the script could not be fetched (it errored or is no longer served)",
  "auth-required":
    "the script or its map is behind authentication (a 401/403); wpd's fetches carry no cookies or credentials",
  "map-fetch-failed": "the .map it names could not be fetched (commonly not deployed alongside it)",
  "map-parse-failed": "the .map it names is not a readable sourcemap",
  "script-too-large": "the script exceeded the remote-fetch size cap and was not read",
  "map-too-large": "the .map it names exceeded the remote-fetch size cap and was not read",
  "fetch-budget-exhausted":
    "the per-run remote-sourcemap time budget ran out before this script (heavy site with many scripts)",
  "blocked-fetch":
    "the fetch was refused by policy (a non-http(s) scheme, or a private host reached from a public page)",
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
export function sourcemapNote(
  diagnostics: SourceMapDiagnostics,
  unmappedFrames: number,
): string | null {
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

/**
 * One note when a script's map LOADED but had no mapping for some queried frames, or null. This is a
 * different failure from the load-failure reasons `sourcemapNote` reports: the map resolved, so
 * `resolved` counts it a success, yet those position-missed frames kept their minified/remote
 * identity and bucketed by origin. Lists the scripts `diagnostics.positionMisses` carries (the worst
 * by miss count, capped), not every one that missed, and says so, so a reader never reads the count
 * as exhaustive. No milliseconds: the missed self-time already lands in the origin/file buckets, and
 * attaching a number to a count of missed lookups would fabricate a cost.
 */
export function positionMissNote(diagnostics: SourceMapDiagnostics): string | null {
  const positionMisses = diagnostics.positionMisses;
  if (!positionMisses) return null;
  const scripts = Object.entries(positionMisses);
  if (scripts.length === 0) return null;
  const detail = scripts
    .map(
      ([script, counts]) =>
        `${script} (${counts.misses} of ${counts.misses + counts.hits} frame lookups unmapped)`,
    )
    .join("; ");
  return `NOTE: ${scripts.length} script(s) in meta.sourcemaps.positionMisses (the worst by miss count, capped) had a resolved sourcemap that still returned no mapping for some frame lookups, so those frames kept their minified/remote identity and bucketed by origin, not their real source: ${detail}.`;
}

/**
 * The origin the static server grants CORS read access to, or undefined for none. Only a `--url`
 * BENCH run imports the served module cross-origin into the remote host page; driver mode import()s
 * the module in Node and loads nothing from the loopback server into the page, so it needs no grant.
 * html/module mode serves the host page from the same server (same-origin). An unparseable `--url`
 * yields undefined, so a bad value never widens access.
 */
function hostPageOrigin(
  mode: "module" | "html" | "url",
  bench: boolean,
  url?: string,
): string | undefined {
  if (mode !== "url" || !bench || !url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

export async function record(opts: RecordOptions): Promise<{
  recording: Recording;
  outPath: string;
  cpuProfilePath?: string;
  cpuModelPath?: string;
  cpuModel?: CpuModel;
}> {
  const root = process.cwd();
  // No module = the built-in on-ramp: a driver flow that loads --url/--html and settles, so a first
  // run needs zero authoring. runPass/runDriver synthesize the single "load" step from the target.
  const isOnramp = !opts.module;
  // The CLI guards this, but record() is also a programmatic API: without a module there is
  // nothing to run unless a host page names the built-in load flow.
  if (isOnramp && !opts.url && !opts.html)
    throw new Error(
      "record() needs a module to run, or url/html so the built-in load flow has a page to load.",
    );
  const absModule = opts.module ? path.resolve(opts.module) : undefined;
  if (absModule)
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

  // The one capture that runs for this invocation (capture mode/lane). Every invocation is exactly one
  // pass: one browser launch, one run of the flow, one recording.
  const capture = captureFor(opts, browserName);
  const capabilities = capabilitiesFor(capture, browserName);
  const wantTrace = capture.categories != null;

  // In --url bench mode the host page is a remote origin that import()s the served module cross-origin,
  // so that one origin is granted CORS read access; every other mode serves the host page same-origin
  // and needs none. Never a wildcard: it would expose cwd files to any site open in the operator's
  // browser for the life of the run.
  const server = await startStaticServer(root, hostPageOrigin(mode, !opts.driver, opts.url));
  // One resolver for the whole run: stack resolution and the CPU model share its cache (a remote
  // script + map is fetched once) and its diagnostics, so `maps.diagnostics()` below sees every
  // script the run tried to map.
  // pageUrl (--url) tells the resolver whether the profiled page is public: a public page's bundle
  // may not make wpd fetch a private/internal host for a sourcemap.
  const maps = new SourceMapResolver({ pageUrl: opts.url });
  let pass: PassResult;
  // A cross-process --url boot can fail the top-level navigation with a transient error
  // (net::ERR_INVALID_HANDLE and friends; the renderer process swaps mid-navigation). Retry it a
  // bounded number of times on a fresh browser (runPass launches its own) before giving up, and
  // disclose it in a note when it fired -- never a silent infinite retry, never a swallowed permanent
  // failure (a bad host still fails immediately). See browser/launch.ts isTransientNavError.
  let navRetries = 0;
  try {
    const outcome = await retryTransientNav(
      () => runPass(server, root, capture, opts, mode, absModule, maps),
      NAV_RETRY_LIMIT,
    );
    pass = outcome.value;
    navRetries = outcome.retries;
  } finally {
    await server.close();
  }

  // One pass carries everything now: wall/steps, the trace (if any), and the CPU/gecko profile.
  const timing = pass;
  const detail = pass;

  // Merge the pass's steps HERE, before anything is written. mergeSteps rejects a flow whose
  // per-iteration steps disagree, and that rejection has to happen before the recording, the digest
  // and the `latest` pointer exist: a run that failed after writing artifacts but before repointing
  // `latest` would leave `assert latest` silently gating the PREVIOUS run instead. Pair by LABEL:
  // the step timings and the trace windows come from the same pass. No window (default/precise-wall
  // capture mode, or lost markers) means nothing to pair with -- pass undefined rather than an empty list,
  // which would read as divergence.
  const mergedSteps =
    opts.driver && timing.driverSteps?.length
      ? mergeSteps(
          timing.driverSteps,
          detail.windowStart == null ? undefined : detail.stepWindows,
          detail.traceDataLoss,
        )
      : undefined;

  // The pass's profile feeds the CPU model AND (in breakdown mode) the per-span bars.
  const cpuPass = pass.cpuProfile ? pass : undefined;

  const notes: string[] = [];
  if (opts.breakdown && !cpuPass?.cpuProfile) {
    // The fused pass yielded no sampler profile, so buildBreakdowns produces nothing. Do NOT emit
    // the breakdown-mode notes below: they describe bars this run did not compute.
    notes.push(notesCatalog.breakdownNoProfile());
  } else if (opts.breakdown) {
    // The seven-slice breakdown is the product here; state its shape and, loudly, what a light trace
    // structurally cannot measure so a 0 is never read as clean.
    notes.push(notesCatalog.breakdownShape());
    notes.push(notesCatalog.breakdownForcedNotMeasured());
    notes.push(notesCatalog.breakdownInvalidationNotMeasured());
  } else if (opts.deep && browserName !== "firefox") {
    // Chrome --deep: exact counts + forced-layout blame are the product; slice durations are
    // suppressed (null) because the `.stack` trace distorts them. Say so, and that there is no
    // bar/CPU model. Firefox --deep is NOT this capture mode -- it is the gecko pass plus a report
    // tier, so it falls to the firefox branch below (which adds the dirtied-by note).
    notes.push(notesCatalog.deepCaptureMode());
  } else if (opts.preciseWall) {
    // The default capture mode minus the sampler: only the wall is measured. No counts, no CPU model.
    notes.push(notesCatalog.preciseWall());
  } else if (browserName === "firefox") {
    notes.push(notesCatalog.firefoxBackend());
    // The counts are NOT simply absent on Firefox: with a gecko pass, summarize falls back to
    // counting Reflow/Styles markers, so layoutCount/styleCount/forcedLayoutCount carry real
    // numbers. Saying "not measured" would hide a working signal; leaving them unqualified would
    // invite diffing them against Chrome's counts, which count a differently-batched thing. Name
    // which fields are real, which are not measured, and what the real ones may be compared to.
    // The cpuProfile:false branch is unreachable from the CLI (firefox always samples: there is no
    // flag to turn it off); a programmatic caller can still land there.
    notes.push(
      opts.cpuProfile
        ? notesCatalog.firefoxRenderingCountsMeasured()
        : notesCatalog.firefoxRenderingCountsDisabled(),
    );
    // forcedLayoutCount here derives from Gecko marker cause stacks (the write-site JS cause), which
    // flags reflows Chrome's read-site rule reports 0 for. Disclose it so the count is never diffed
    // cross-engine. Only when the gecko pass ran: without it every count is a hard 0 (note above).
    if (opts.cpuProfile) notes.push(notesCatalog.firefoxForcedCountSemantics());
    // --deep on firefox is a reporting tier over the same gecko pass: it surfaces Gecko's native
    // cause-stack write identity as a dirtied-by (first-invalidation-only) report. The note states
    // the honest scope loudly (no exact-count parity, no forced-by, no thrash) so the write is never
    // read as chrome's full set.
    if (opts.deep) notes.push(notesCatalog.firefoxDeepReport());
    // INP is deliberately NOT in the caps list above: it never came from CDP. It is the same
    // in-page Event Timing observer Chrome uses, so it works here; the honest caveat is that the
    // two engines' numbers are not interchangeable, not that Firefox cannot measure it.
    notes.push(notesCatalog.firefoxInp());
    // The reconciling CPU breakdown note is pushed AFTER the CPU model is built (below), where its
    // presence is known: it is produced when the Gecko dump carried the threadCPUDelta CPU signal.
  } else {
    // Default capture mode (chrome): the CPU sampler alone, no trace, for the cleanest wall (~1%). No
    // rendering counts at all -- reported not-measured, never 0 -- and the sampler perturbs wall.
    notes.push(notesCatalog.defaultCaptureMode());
    notes.push(notesCatalog.cpuSamplerOnDefaultMode());
  }
  // The built-in on-ramp flow: disclose what the single "load" step measures, and (when repeated)
  // either the warm/cold caveat on the resulting wall median, or -- when this capture mode priced no
  // wall at all (the navigating load step resets the page clock and the default/precise-wall capture
  // mode has no trace clock to span it) -- that there IS no median here and --breakdown is what produces
  // one. Emitting the warm/cold note in the no-wall capture mode would promise a median (`stats`) the
  // recording does not carry.
  if (isOnramp) {
    notes.push(notesCatalog.onrampBuiltinFlow());
    if (opts.iterations > 1) {
      notes.push(
        pass.stepWallClock === "none"
          ? notesCatalog.onrampIterationsNoMedian(opts.iterations)
          : notesCatalog.onrampWarmVsCold(opts.iterations),
      );
    }
  }
  // --url named a host with no scheme (localhost:5173): http:// was assumed to reach it. Disclose
  // the target the run actually navigated to, whether or not a module drove it.
  if (opts.urlSchemeAssumed && opts.url) notes.push(notesCatalog.pageSchemeAssumed(opts.url));
  // Which clock priced the driver step walls (§17.3.1): the trace clock under --breakdown/--deep, the
  // page's own performance.now in a no-trace capture mode, never the node-side page.click bound. "none"
  // means every step navigated in a no-trace capture mode, so no wall could be priced.
  if (opts.driver && pass.stepWallClock) {
    const clock = pass.stepWallClock;
    if (clock === "none") notes.push(notesCatalog.driverStepWallUnmeasured());
    else notes.push(notesCatalog.driverStepWallClock(clock));
  }
  // The navigation hit a transient cross-process error and a fresh-browser retry recovered it.
  if (navRetries > 0) notes.push(notesCatalog.navRetried(navRetries));
  // chrome-headless-shell was missing, so the launch fell back to new-headless.
  if (pass.headlessFallback) notes.push(pass.headlessFallback);
  // A trace ran but its run-window markers are absent (truncated/overflowed trace buffer, or the
  // user_timing category got dropped). Without a window, inWindow() would count the ENTIRE trace
  // (page load, nav, prepare, teardown) as the measured region, silently inflating every
  // trace-derived count. The rendering capture degrades to not-measured and the note says so.
  // Firefox has its own honest notes (above); the default/precise-wall capture mode has no trace, so a
  // missing window there is the capture mode working, not a buffer overflow.
  const traceWindowMissing = detail.windowStart == null && browserName !== "firefox" && wantTrace;
  const effectiveCapabilities = capabilitiesAfterParse(capabilities, !traceWindowMissing);
  const countScope = countScopeNote(effectiveCapabilities, opts);
  if (countScope) notes.push(countScope);
  // A top-level cross-process navigation (typical of a --url boot) marks wpd:run:start on the
  // pre-navigation renderer while the window's rendering work lands on the process the page navigated
  // into. mainThread re-anchors the counts/bar to that thread; disclose it so a reader knows the
  // numbers describe the loaded page, not the blank host it started on. Fires for any counting chrome
  // capture mode (--breakdown/--deep); firefox is single-process (no CDP trace) and the no-trace
  // capture modes count nothing. Skipped when the window was lost (counts already downgraded to not-measured).
  const threadSelection =
    effectiveCapabilities.counts && browserName !== "firefox" ? mainThread(detail.events) : null;
  if (threadSelection?.via === "reanchored") notes.push(notesCatalog.reanchoredMainThread());
  // The run's rendering work landed on more than one renderer process (successive cross-process
  // navigations), so no single main thread holds all of it: the counts and bar describe only the
  // busiest thread, and a step that ran in a different process reports what little it did on the
  // selected thread. Loud, never a silent js:0/idle:100% for the un-tiled process.
  if (threadSelection?.split) {
    const splitNote = notesCatalog.crossProcessWorkSplit();
    notes.push(splitNote);
    console.error(splitNote);
  }
  if (opts.cpuThrottle) {
    notes.push(notesCatalog.artificialSlowdown(opts.cpuThrottle));
  }
  if (opts.disableSandbox && browserName === "chrome") {
    const sandboxNote = notesCatalog.browserSandboxDisabled();
    notes.push(sandboxNote);
    // Loud on stderr too: a reduced-containment launch should not be silent even when the reader
    // never opens meta.notes.
    console.error(sandboxNote);
  }
  if (traceWindowMissing) notes.push(notesCatalog.traceWindowMissing());
  // Chrome reported the trace buffer overflowed and dropped events (even recordAsMuchAsPossible has a
  // ceiling on a very heavy --deep page). Trace-derived counts can undercount, so disclose it loudly
  // in the recording AND on stderr: a dropped event silently turns an exact count into a wrong one.
  if (detail.traceDataLoss) {
    const dataLossNote = notesCatalog.traceDataLoss();
    notes.push(dataLossNote);
    console.error(dataLossNote);
  }
  // --keep-partial salvaged a run whose later iteration failed. Loud in the recording AND on stderr:
  // a salvaged run must never be read as a clean full run.
  if (pass.partial) {
    const partialNote = notesCatalog.partialIterations(
      pass.partial.requested,
      pass.partial.completed,
      pass.partial.failedIteration,
      pass.partial.failedStep,
      pass.partial.reason,
    );
    notes.push(partialNote);
    console.error(partialNote);
  }
  // The run window opened (start mark found) but never closed (run:end lost). traceWindowMissing only
  // fires on a missing START, so without this the bar goes silently absent (buildBreakdowns needs both
  // bounds) while counts stay valid (start-onward). Disclose it; no capability downgrade.
  const runEndMarkLost =
    !traceWindowMissing &&
    detail.windowStart != null &&
    detail.windowEnd == null &&
    browserName !== "firefox" &&
    wantTrace;
  if (runEndMarkLost) notes.push(notesCatalog.runEndMarkLost());
  // The chrome run counts and the reconciling bar cover different windows on purpose: counts are
  // start-onward (they catch the trailing frame that paints just after run:end), the bar tiles
  // [run:start, run:end]. Disclose it when both exist with ms (chrome --breakdown: exact counts AND
  // a bar), so a run paint/layout count reading larger than its slice is not misread as a bug.
  // Chrome only: the gecko lane windows its markers bounded (both sides clip to run:end) and reports
  // paint as not-measured, so start-onward is not the firefox count rule and the note would be false.
  if (
    effectiveCapabilities.counts &&
    effectiveCapabilities.durations &&
    detail.windowStart != null &&
    detail.windowEnd != null &&
    browserName !== "firefox"
  )
    notes.push(notesCatalog.runCountWindow());
  // A driver step's end mark was lost (start present, end null): its counts + bar window to the run
  // end (an over-estimate) and its wall stays page-clock, so it does not reconcile with its bar.
  const stepEndMarkLost = (mergedSteps ?? []).some(
    (step) => step.startTs != null && step.endTs == null,
  );
  if (stepEndMarkLost) notes.push(notesCatalog.stepEndMarkLost());

  const throttle = opts.cpuThrottle ? { cpuRate: opts.cpuThrottle } : undefined;

  const meta: RecordingMeta = {
    tool: TOOL,
    version: VERSION,
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    mode,
    target:
      mode === "url"
        ? opts.url!
        : stableWorkloadPath(root, mode === "html" ? opts.html! : opts.module!),
    // Host and module are separate axes: `target` collapses them (a host page overwrites the module),
    // so the executed flow's identity lives here for the diff/cpu-diff workload check.
    workload: {
      lane: opts.driver ? (opts.module ? "driver" : "builtin-load") : "bench",
      host:
        mode === "url" ? opts.url! : mode === "html" ? stableWorkloadPath(root, opts.html!) : null,
      module: opts.module ? stableWorkloadPath(root, opts.module) : null,
    },
    // Opt-in only; absent unless --variant was passed, so old recordings and unflagged runs are unchanged.
    variant: opts.variant,
    fn: opts.fn,
    // --keep-partial salvaged a run whose later iteration failed: the recording covers only the
    // iterations that completed, so meta.iterations is that count, not the requested one (the note
    // below discloses the failure). Otherwise the requested count.
    iterations: pass.partial ? pass.partial.completed : opts.iterations,
    warmup: opts.warmup,
    headless: opts.headless,
    // Flavour only when headless and on chrome (firefox/headed have no shell/new distinction).
    headlessMode:
      opts.headless && browserName === "chrome" ? (opts.headlessMode ?? "shell") : undefined,
    cpuIntervalUs: opts.cpuIntervalUs ?? DEFAULT_CPU_INTERVAL_US,
    userDataDir: shorterPath(root, opts.userDataDir),
    lifecycle: detail.lifecycle,
    // The one capture that ran, by capture-mode name (there is no multi-pass plan).
    passes: [capture.mode],
    notes,
    driver: opts.driver,
    // Omit on Chrome so existing recordings are unchanged; readers default absent => "chrome".
    browser: browserName === "firefox" ? "firefox" : undefined,
    blameSemantic: blameSemanticFor(capture),
    throttle,
  };

  // Last resort for an in-page run whose harness reported no samples (e.g. run() threw after the
  // marks landed): the wpd:run marks span the timed loop on the clean pass.
  const wallFromMarks = (): number | null => {
    const start = timing.marks.find((entry) => entry.name === RUN_START_MARK)?.startTime;
    const end = timing.marks.find((entry) => entry.name === RUN_END_MARK)?.startTime;
    return start != null && end != null ? end - start : null;
  };
  // Bench wall is the time actually spent in run(), summed over every timed iteration. The samples
  // are measured in-page around run() alone and are the exact samples `stats` describes, so the
  // headline and the distribution cannot disagree. It is NOT the trace window: that would span one
  // iteration under a full window or bracket the whole loop, and it carries trace-emission overhead.
  const benchWallMs = (): number | null =>
    timing.perIteration.length
      ? timing.perIteration.reduce((total, iterationMs) => total + iterationMs, 0)
      : null;
  // A driver run has NO run-level wall, deliberately: there is no honest number to put here. The
  // run marks span prepare + every step + inter-step driver overhead + the settle sleep, which is
  // no interaction anyone ran, and is ~90% settle floor plus input dispatch (docs/dev/driver-timing.md).
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

  // The deep event log is stored ONLY where a reader consumes it: --deep (`.stack` + invalidation
  // records for blame/dirtied-by) and firefox (gecko rendering events with sampled blame). Every
  // other capture mode leaves it empty, which keeps the default artifact digest-sized; `query events`/`get`/
  // `blame` there report "not captured in this capture mode". buildBreakdowns and per-step counts still read
  // the full `detail.events` at record time regardless -- this gates only what is STORED.
  const storeEventLog = opts.deep || browserName === "firefox";
  const recording: Recording = {
    meta,
    window: {
      measure: RUN_MEASURE,
      startTs: detail.windowStart,
      endTs: detail.windowEnd,
      wallMs: runWallMs,
    },
    marks: timing.marks,
    events: storeEventLog ? detail.events : [],
    // Assembled below, once the summary is finalized and any per-span bars are built.
    spans: [],
    summary: buildSummary({
      // perIteration is bench-only: it feeds computeStats, which is only meaningful over
      // repetitions of the SAME work. Driver steps are heterogeneous ("mount" vs "inp"), so
      // their walls go to perStep instead and are never summarized into a median.
      perIteration: opts.driver ? [] : timing.perIteration,
      // Clean in-page walls, one sample per step per --iterations, grouped by label in mergeSteps,
      // which is the only place that knows a repeated label is a repetition rather than a collision.
      // buildSummary derives the stats; never pass a statistic in from here.
      perStep:
        mergedSteps?.map((step) => ({ label: step.label, perIteration: step.perIteration })) ?? [],
      // In-page (bench/node): the summed timed samples. Driver: null on purpose; see runWallMs.
      wallMs: runWallMs,
      inpMs: overallInp,
      interaction: overallInteraction,
      // No window => not measured (see traceWindowMissing note); don't count the whole trace.
      detailEvents: traceWindowMissing ? [] : detail.events,
      detailWindowStart: detail.windowStart,
      // What this capture mode could observe (per capture): gates each count/duration to Measured null
      // vs a number, so the default mode reports no counts and --deep reports counts but null durations.
      capabilities: effectiveCapabilities,
      // scriptingMs is patched in after the CPU model is built below (it is the model's JS
      // self-time); null here, and stays null on --deep, which has no sampler and no model.
      scriptingMs: null,
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
      // Strip the trace-lane-only sampleTimestampsUs so the raw file stays the standard DevTools shape.
      await fs.writeFile(
        cpuProfilePath,
        JSON.stringify(toDevtoolsCpuProfile(cpuPass.cpuProfile)),
        "utf8",
      );
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
  // scriptingMs is the CPU model's JS self-time. Patched onto the summary here (the model exists
  // now, and `recording.summary` is shared by reference), so a capture mode with no sampler (--deep) keeps
  // the null it was built with -- a distinct not-measured, never a fake 0.
  if (cpuModel) recording.summary.scriptingMs = cpuModel.scriptingMs;
  // On the trace-sourced --breakdown lane the sampler interval is the v8.cpu_profiler stream's own
  // fixed rate (read back from the chunks), not a value wpd requested, so record that observed
  // interval rather than the default constant this lane does not use. Chrome only: firefox keeps the
  // requested value in meta (its actual gecko interval already lives on the CpuModel).
  if (cpuModel && cpuPass?.cpuSampleIntervalUs != null && browserName === "chrome")
    meta.cpuIntervalUs = cpuModel.sampleIntervalUs;
  // Disclose the --breakdown CPU sample source (the trace stream, continuous across navigation) and
  // its fixed interval, once the model exists so the interval is the observed rate. Only when the
  // fused pass produced a profile; the no-profile case has its own breakdownNoProfile note above.
  if (
    opts.breakdown &&
    browserName === "chrome" &&
    cpuModel &&
    cpuPass?.cpuSampleIntervalUs != null
  )
    notes.push(notesCatalog.breakdownTraceCpuSource(cpuModel.sampleIntervalUs));

  // Firefox CPU breakdown note: produced when the Gecko dump carried the threadCPUDelta CPU signal
  // (js,cpu feature), absent otherwise (an older dump). Pushed here, after the model exists, so it
  // describes the bar that was actually built.
  if (browserName === "firefox") {
    notes.push(
      cpuModel?.breakdown ? notesCatalog.firefoxBreakdown() : notesCatalog.firefoxNoCpuBreakdown(),
    );
  }

  // The reconciling per-span bars (run + driver steps + user measures), when the capture mode built any.
  // --breakdown: built here because it needs both the trace events (with pid/tid) and the raw CPU
  // samples, sharing the run's one resolver so a sample's package matches `query cpu --by package`.
  // Firefox: the mark-bridge measure bars from the Gecko sample slices. Every other capture mode leaves it
  // empty (no bar), so a span's `breakdown` is simply absent there.
  // The sampler interval a per-span hot ref's selfMs is priced in (firefox reports what it actually
  // ran at; V8 honours the request). The model exists in any capture mode that built bars, so this is set.
  const sampleIntervalUs =
    cpuModel?.sampleIntervalUs ?? opts.cpuIntervalUs ?? DEFAULT_CPU_INTERVAL_US;
  let bars: SpanBreakdown[] = [];
  if (opts.breakdown && cpuPass?.cpuProfile) {
    bars = await buildBreakdowns(
      detail.events,
      cpuPass.cpuProfile,
      { startTs: detail.windowStart, endTs: detail.windowEnd },
      mergedSteps,
      { serverUrl: server.url, root, maps, notes, sampleIntervalUs },
    );
  } else if (
    browserName === "firefox" &&
    cpuPass?.cpuProfile?.gecko &&
    cpuPass.geckoMeasures?.length &&
    cpuModel?.breakdown
  ) {
    const packageByNode = await packagesByProfileNode(cpuPass.cpuProfile, {
      serverUrl: server.url,
      root,
      maps,
    });
    bars = buildGeckoSpanBreakdowns(
      cpuPass.cpuProfile,
      packageByNode,
      cpuPass.geckoMeasures,
      { startTs: detail.windowStart, endTs: detail.windowEnd },
      sampleIntervalUs,
    );
  }

  // Collapse the run, every driver step, and every user measure into the stored Span[]. Steps carry
  // their windowed counts (from detail.events, iteration 0); bars attach where the capture mode built one.
  recording.spans = buildRecordingSpans({
    summary: recording.summary,
    mergedSteps,
    detailEvents: detail.events,
    capabilities: effectiveCapabilities,
    bars,
    runWindowEnd: detail.windowEnd,
  });

  // Every frame the run will ever resolve has now been resolved, so the tally is final. A failed
  // map is otherwise silent: frames keep their minified names and bundle path, and per-package CPU
  // numbers look plausible while attributing everything to the bundle. Mutating `meta` here (not
  // at construction) is what lets every artifact below carry the same verdict.
  const sourcemaps = maps.diagnostics();
  // ALWAYS record the diagnostics when any script was attempted: a trace resolves stacks through
  // this same resolver, so `blame`'s source attribution depends on it just as `query cpu` does.
  // Gating the data on a CPU model existing would silently drop the only evidence a sampler-off
  // capture mode (--deep) has about its own blame.
  if (sourcemaps.scripts > 0) meta.sourcemaps = sourcemaps;
  // The NOTE is CPU-worded ("query cpu --by package"), so it needs a model to be about anything;
  // and it returns null when a missing map cost nothing at all.
  if (sourcemaps.scripts > 0 && cpuModel) {
    const note = sourcemapNote(sourcemaps, cpuModel.unmappedFrames ?? 0);
    if (note) notes.push(note);
  }
  // Position misses need no CPU model: they leak on the trace-stack (blame) path too, and are honest
  // counts, not CPU-worded. Push independently, whenever a resolved map dropped a queried frame.
  if (sourcemaps.scripts > 0) {
    const missNote = positionMissNote(sourcemaps);
    if (missNote) notes.push(missNote);
  }

  // Artifact writes, kept together and AFTER the meta mutation above: `meta` is shared by reference
  // with every file below, so its sourcemap verdict has to be final before the first serialize. The
  // At most three files: the one default artifact (Span[] + summary + meta, plus the deep event log
  // under --deep/firefox), the raw profile, and the resolved CPU model. There is no separate
  // step-index file -- `query spans`/`query span <label>` derive their views from the spans.
  await writeRecording(outPath, recording, opts.format);
  if (cpuModel && cpuProfilePath) {
    cpuModelPath = path.join(outDir, `${base}.cpu${extFor(opts.format)}`);
    await writeCpuModel(cpuModelPath, cpuModel, opts.format);
  }
  // Pointer so `query/assert/diff … latest` resolve reliably (not by mtime). One artifact kind, so
  // every verb resolves to the same recording, from which its view is built.
  await writePointer({
    recording: outPath,
    cpuProfile: cpuProfilePath,
    cpuModel: cpuModelPath,
  });

  return { recording, outPath, cpuProfilePath, cpuModelPath, cpuModel };
}

/** Terminal report for a --target node run: CPU headline + per-iteration timing, no DOM tables. */
function printNodeReport(result: {
  recording: Recording;
  outPath: string;
  cpuProfilePath: string;
  cpuModelPath: string;
  cpuModel: CpuModel;
}): void {
  const meta = result.recording.meta;
  const variant = meta.variant ? ` ${dim(`· variant ${meta.variant}`)}` : "";
  console.log(`\n${bold(meta.tool)} — node:${meta.target}  ${dim(`(fn: ${meta.fn})`)}${variant}`);
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

  console.log(
    `\nRecording:  ${dim(`${displayPath(result.outPath)}  ← CPU-only run; rendering metrics are not collected`)}`,
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
  const { recording, outPath, cpuProfilePath, cpuModelPath, cpuModel } = await record(opts);
  printSummary(recording);
  // When CPU profiling was requested, lead with its headline; the layout/paint summary
  // above is not the signal the user asked for (and its scripting-ms can read 0).
  if (cpuModel) {
    printCpuHeadline(cpuModel);
    // Directly under the package table, because it says whether that table can be believed.
    printSourcemapLine(recording.meta.sourcemaps, cpuModel.unmappedFrames ?? 0);
    // In --breakdown mode the seven-slice per-span bars replace the single profile-only bar.
    const barSpans = recording.spans.filter((span) => span.breakdown);
    if (barSpans.length)
      printSpanBreakdowns(barSpans, recording.meta.iterations, recording.meta.browser);
    else printCpuBreakdown(cpuModel);
  }
  if (recording.meta.throttle?.cpuRate) {
    console.log(`\nslowdown: cpu ${recording.meta.throttle.cpuRate}x`);
  }
  console.log(
    `\nRecording:  ${dim(`${displayPath(outPath)}  ← the run's spans + summary; 'query spans' / 'query span <label>' read it`)}`,
  );
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
}
