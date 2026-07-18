import { promises as fs } from "node:fs";
import path from "node:path";
import type { HeadlessMode } from "../browser/launch.js";
import { capsFor, type BrowserName } from "../browser/backend.js";
import { startStaticServer } from "../browser/server.js";
import { mergeSteps, type MergedStep } from "../trace/steps.js";
import { SourceMapResolver } from "../trace/sourcemap.js";
import { buildSummary } from "../metrics/summarize.js";
import {
  buildCpuModel,
  packagesByProfileNode,
  DEFAULT_CPU_INTERVAL_US,
} from "../profile/cpuprofile.js";
import { buildGeckoSpanBreakdowns } from "../profile/gecko-breakdown.js";
import { buildPassSpecs, blameSemanticFor, noteCountScope } from "../record/passplan.js";
import { runPass, type PassResult } from "../record/runpass.js";
import { buildBreakdowns, userMeasureSpans } from "../record/breakdown-spans.js";
import { writeRecording, writeDigest, writeCpuModel, writeStepIndex } from "../record/artifacts.js";
import * as notesCatalog from "../record/notes.js";
import { RUN_START_MARK, RUN_END_MARK, RUN_MEASURE } from "../model/marks.js";
import { printCpuHeadline, printCpuBreakdown, printSpanBreakdowns } from "./cpu.js";
import { printSummary } from "./summaryView.js";
import { kv, num, sparkline } from "../output/ascii.js";
import { bold, cyan, dim } from "../output/color.js";
import { writePointer } from "./resolve.js";
import { extFor, type Format } from "../output/format.js";
import { VERSION, TOOL } from "../version.js";
import { SCHEMA_VERSION } from "../schema.js";
import type {
  CpuModel,
  Recording,
  RecordingMeta,
  SourceMapDiagnostics,
  SourceMapFailure,
} from "../model/recording.js";

// The two-pass machinery, the seven-slice span builder, and the artifact writers live in
// src/record/. record.ts stays the orchestrator: it wires the passes, mutates `meta` in the one
// load-bearing order, and drives the writers. These re-exports keep the compiled dist surface
// stable for the tests and programmatic consumers that import them from this module.
export { blameSemanticFor, noteCountScope, userMeasureSpans };

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
  /** chrome headless flavour: "shell" (default, ~120Hz frames) or "new"; ignored when headed/firefox */
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

  const wantTrace = opts.trace !== false;
  const specs = buildPassSpecs(opts, browserName);

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
    notes.push(notesCatalog.breakdownNoProfile());
  } else if (opts.breakdown) {
    // The seven-slice breakdown is the product here; state its shape and, loudly, what a light trace
    // structurally cannot measure so a 0 is never read as clean.
    notes.push(notesCatalog.breakdownShape());
    notes.push(notesCatalog.breakdownForcedNotMeasured());
    notes.push(notesCatalog.breakdownInvalidationNotMeasured());
  } else if (browserName === "firefox") {
    notes.push(notesCatalog.firefoxBackend());
    // The counts are NOT simply absent on Firefox: with a gecko pass, summarize falls back to
    // counting Reflow/Styles markers, so layoutCount/styleCount/forcedLayoutCount carry real
    // numbers. Saying "not measured" would hide a working signal; leaving them unqualified would
    // invite diffing them against Chrome's CDP counts, which count a differently-batched thing.
    // Name which fields are real, which are a hard 0, and what the real ones may be compared to.
    // The cpuProfile:false branch is unreachable from the CLI (it errors on --target firefox
    // --no-cpu-profile); a programmatic caller can still land there.
    notes.push(
      opts.cpuProfile
        ? notesCatalog.firefoxRenderingCountsMeasured()
        : notesCatalog.firefoxRenderingCountsDisabled(),
    );
    // INP is deliberately NOT in the caps list above: it never came from CDP. It is the same
    // in-page Event Timing observer Chrome uses, so it works here; the honest caveat is that the
    // two engines' numbers are not interchangeable, not that Firefox cannot measure it.
    notes.push(notesCatalog.firefoxInp());
    // The reconciling CPU breakdown note is pushed AFTER the CPU model is built (below), where its
    // presence is known: it is produced when the Gecko dump carried the threadCPUDelta CPU signal.
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

    notes.push(timingIsTraced ? notesCatalog.timingInstrumented() : notesCatalog.timingClean());
    notes.push(tracePass ? notesCatalog.paintCountsSeparatePass() : notesCatalog.noTracePass());
    if (timingPass?.cpu) notes.push(notesCatalog.cpuSamplerOnTimingPass());
    // The sampler must not ride the trace pass (it would inflate self-time ~21%; see the timingSpec
    // note), so a plan with no timing pass has no CPU model. Say so: silently dropping it would
    // read as "this run had no JS worth sampling".
    if (opts.cpuProfile && !timingPass) notes.push(notesCatalog.noCpuModelNoIsolate());
  }
  // chrome-headless-shell was missing on at least one pass, so the launch fell back to new-headless.
  // Both passes fall back identically, so the note is the same on each: report it once.
  const headlessFallbackNote = results.find((pass) => pass.headlessFallback)?.headlessFallback;
  if (headlessFallbackNote) notes.push(headlessFallbackNote);
  const countScope = noteCountScope(specs, opts, capsFor(browserName));
  if (countScope) notes.push(countScope);
  if (opts.cpuThrottle || opts.network) {
    notes.push(notesCatalog.artificialSlowdown(opts.cpuThrottle, opts.network));
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
  if (traceWindowMissing) notes.push(notesCatalog.traceWindowMissing());

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
    const start = timing.marks.find((entry) => entry.name === RUN_START_MARK)?.startTime;
    const end = timing.marks.find((entry) => entry.name === RUN_END_MARK)?.startTime;
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
      measure: RUN_MEASURE,
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

  // Firefox CPU breakdown note: produced when the Gecko dump carried the threadCPUDelta CPU signal
  // (js,cpu feature), absent otherwise (an older dump). Pushed here, after the model exists, so it
  // describes the bar that was actually built.
  if (browserName === "firefox") {
    notes.push(
      cpuModel?.breakdown ? notesCatalog.firefoxBreakdown() : notesCatalog.firefoxNoCpuBreakdown(),
    );
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

  // Firefox mark bridge: a per-span breakdown for each user performance.measure inside the run
  // window, built from the same Gecko sample slices as CpuModel.breakdown (run bar). Only when the
  // CPU signal produced a reconciling breakdown (cpuPass.cpuProfile.gecko) and the flow made
  // measures; otherwise Recording.breakdowns stays unset and the run bar shows via CpuModel.breakdown.
  if (
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
    recording.breakdowns = buildGeckoSpanBreakdowns(
      cpuPass.cpuProfile,
      packageByNode,
      cpuPass.geckoMeasures,
      {
        startTs: detail.windowStart,
        endTs: detail.windowEnd,
      },
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

  // Artifact writes, kept together in one visual field and AFTER the meta mutation above: `meta` is
  // shared by reference with every file below, so its sourcemap verdict has to be final before the
  // first serialize. The writers themselves are pure (src/record/artifacts.ts); their ORDER, and
  // that it follows the mutation, is the load-bearing part and stays here.
  await writeRecording(outPath, recording, opts.format);
  if (cpuModel && cpuProfilePath) {
    cpuModelPath = path.join(outDir, `${base}.cpu${extFor(opts.format)}`);
    await writeCpuModel(cpuModelPath, cpuModel, opts.format);
  }
  // Small, context-friendly entry point that points back into the big file by id.
  const digestPath = path.join(outDir, `${base}.digest${extFor(opts.format)}`);
  await writeDigest(digestPath, recording, outPath, opts.format, 20);
  // Driver/stepped runs: split the report into one file per step + an index.
  let indexPath: string | undefined;
  if (mergedSteps) {
    indexPath = await writeStepIndex({
      outDir,
      base,
      format: opts.format,
      meta,
      recordingPath: outPath,
      detailEvents: detail.events,
      mergedSteps,
      forcedMeasured: !opts.breakdown,
    });
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
