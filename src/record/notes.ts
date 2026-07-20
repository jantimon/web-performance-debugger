/**
 * The catalog of every fixed `meta.notes` string, one function per note. The TRIGGER logic (which
 * note fires, and when) stays at the call sites in src/record/*, runtime/node.ts and
 * browser/launch.ts; only the WORDING lives here, so a reader auditing what the tool can say reads
 * one file, and an e2e test matching a note substring has one place the text can change.
 *
 * The two algorithmic notes -- count scope (capture.ts `countScopeNote`) and sourcemap resolution
 * (record.ts `sourcemapNote`) -- are not here: their text is assembled from the rung's capabilities
 * and the diagnostics, so wording and logic are inseparable and already live in their own generators.
 */

// --- --breakdown lane ---

export function breakdownNoProfile(): string {
  return "WARNING: --breakdown could not be computed: the trace carried no v8.cpu_profiler ProfileChunk stream, so there are no CPU samples and no per-span breakdown was generated. Rendering counts from the trace are still reported.";
}

export function breakdownShape(): string {
  return "Breakdown mode: ONE fused pass (light trace + CPU samples from the trace's v8.cpu_profiler stream) yields a reconciling js/style/layout/paint/gc/other/idle bar per span (Σ slices + idle = wall). The light trace + sampling ride the same pass as the timing, so per-iteration wall is ~2-5% above a sampler-off wall (--precise-wall).";
}

/** The --breakdown CPU sample source + the trace stream's fixed interval. Pushed after the CPU model
 * is built, so the interval is the rate the stream actually ran at (read back from the chunks). */
export function breakdownTraceCpuSource(intervalUs: number): string {
  return `CPU samples on --breakdown come from the trace's v8.cpu_profiler stream (no CDP profiler runs), which is continuous across a cross-document navigation: a navigating driver step or an early measure occurrence keeps its CPU attribution, unlike the CDP sampler that resets per navigation. The stream samples at a fixed ~${Math.round(intervalUs)}us (read back from the chunk deltas, not a value wpd sets); it is inside the interval-stable band, so the reported percentages do not move.`;
}

export function breakdownForcedNotMeasured(): string {
  return "NOT measured in breakdown mode: forced-layout count and forced-layout blame (they need the `.stack` trace category, which this mode drops); reported as 'not measured', never 0. Run --deep for forced-layout blame and the dirtied-by/thrash report.";
}

export function breakdownInvalidationNotMeasured(): string {
  return "NOT measured in breakdown mode: invalidation counts (layout/style/paint), because the invalidationTracking category is dropped; reported as not measured (—), never 0. Layout/style/paint counts, long tasks, and CPU self-time ARE measured.";
}

/** The chrome run's rendering counts and its reconciling bar cover different windows, by design.
 * Counts are start-onward (analysis.ts inWindow), the bar tiles [run:start, run:end]. Pushed for the
 * chrome --breakdown rung (exact counts AND a bar with ms), where the two sit together and a count
 * can read larger than its slice. Not firefox: the gecko lane windows its markers bounded on both
 * sides and reports paint as not-measured, so start-onward is not its count rule. */
export function runCountWindow(): string {
  return "Run-level rendering counts (layout/style/paint) are windowed start-onward from wpd:run:start with no upper bound, so a paint or layout the run commits just after wpd:run:end (the trailing frame, which paints on the next tick) is counted. The reconciling bar instead tiles [run:start, run:end] exactly, so its slice ms stop at run:end: a run count can be larger than its bar slice would imply. This is not double-counting, it is the trailing frame the count is meant to catch. Per-step counts are windowed to their own step marks and match their step bar.";
}

/** WARNING when the breakdown's main thread was picked by activity because the run:start marker was
 * lost. Pushed from buildBreakdowns, not the record() notes block. */
export function breakdownHeuristicMainThread(): string {
  return "WARNING: the wpd:run:start marker was not found, so the breakdown's main thread was picked by layout/paint activity (heuristic). Per-span breakdown attribution may be on the wrong thread.";
}

/** Some step/measure span attributes JS to a window the CPU sample stream did not cover: no sample
 * landed in it despite its reconciling bar showing real JS. On --breakdown the samples come from the
 * trace's v8.cpu_profiler stream, which is continuous across navigation, so this is now rare (the
 * stream simply produced no sample for that window, or the window predates its first sample), not the
 * per-navigation reset the CDP sampler had. Pushed from buildBreakdowns when the symptom is present, so
 * an empty per-span package split and hot list are read correctly. */
export function samplerCoverageGap(spanCount: number, gapMs: number): string {
  const spans = spanCount === 1 ? "1 step/measure span" : `${spanCount} step/measure spans`;
  return `Per-span CPU attribution (package split, hot functions) is empty for ${spans} whose window ran before the CPU sample stream's first sample (about ${gapMs.toFixed(0)} ms into the run window), or that the stream produced no sample for. The bar ms are trace-measured and correct; only the sample-derived package/hot breakdown of that JS is unavailable there. The run-level CPU model and any covered span are unaffected.`;
}

/** The run window's rendering work landed on a different renderer process than the one wpd:run:start
 * was marked on: a top-level cross-process navigation (typical of a --url boot). Counts and the bar
 * follow the page to its new process. Pushed from record() for any counting rung (--breakdown/--deep). */
export function reanchoredMainThread(): string {
  return "The run navigated to a new renderer process (a top-level cross-process navigation, typical of a --url boot): wpd:run:start was marked on the pre-navigation renderer, but the window's layout/paint/style work ran on the process the page navigated INTO. Counts and the breakdown bar are scoped to that post-navigation renderer main thread, so they describe the page you loaded, not the blank host page it started on.";
}

/** The run's rendering work was split across more than one renderer process (successive cross-process
 * navigations), so no single main thread holds it all. Pushed loudly from record() (and stderr): the
 * counts/bar cover only the busiest thread, so a step that ran in another process must not be read as
 * a clean js:0/idle:100%. */
export function crossProcessWorkSplit(): string {
  return "WARNING: the run's rendering work was split across more than one renderer process (successive cross-process navigations), so no single renderer main thread holds the whole run. The counts and the reconciling bar describe only the busiest thread; a step whose window ran in a DIFFERENT process reports only the little rendering it did on the selected thread (often none), NOT that process's own work, so read its bar as not-covered, never as a clean idle span. Keep each run to one navigation (split the flow, or record the second page in its own run) for counts and a bar that cover all of it.";
}

// --- Firefox lane ---

export function firefoxBackend(): string {
  return "Firefox backend (WebDriver BiDi): no CDP, so no exact counters and no CPU/network throttling. Wall timing rides performance.now (directional) and is measured under the Gecko profiler (~1% systematic cost; cancels in a diff of two Firefox runs).";
}

export function firefoxRenderingCountsMeasured(): string {
  return "Rendering counts on Firefox: layoutCount/styleCount/forcedLayoutCount ARE measured, from the Gecko profiler's Reflow/Styles markers. Gecko batches layout differently than Chrome, so these are approximate and NOT comparable to Chrome's counts: read them against another Firefox run. NOT measured and reported as not-measured (—), never a fake 0: paintCount (off-main-thread), invalidation counts and long tasks (from the DevTools trace, which Gecko has no equivalent of). scriptingMs comes from the CPU model.";
}

export function firefoxRenderingCountsDisabled(): string {
  return "Rendering counts on Firefox come from the Gecko profiler pass, which this run disabled (cpuProfile:false). EVERY rendering count here is reported as not-measured (—) because nothing counted them, not because the page did no work: layout/style/paint, forced layout, invalidations, long tasks, scriptingMs. Wall timing and INP are real.";
}

export function firefoxInp(): string {
  return "INP IS measured on Firefox (in-page Event Timing, the same observer Chrome uses). The two engines' values are not interchangeable: both span the interaction through the next paint and round to 8 ms, but Firefox reports a systematically lower number for identical work because presentation delay differs by engine. Compare a browser against itself across a change, not one engine against the other.";
}

export function firefoxForcedCountSemantics(): string {
  return "Firefox forcedLayoutCount comes from Gecko Reflow/Styles marker cause stacks (the write-site JS cause), not Chrome's read-site rule, so it counts mount-driven reflows Chrome reports 0 for. Never compare forced counts across engines: read a Firefox run against another Firefox run.";
}

export function firefoxDeepReport(): string {
  return "Deep report on Firefox (--deep): the SAME gecko pass, plus a dirtied-by (first-invalidation-only) write report from Gecko's Reflow/Styles cause stacks — the write that dirtied each forced flush. Gecko records only the FIRST invalidation since the last flush, so this is NOT Chrome's full write set: no exact-count parity, no forced-by read side (the read that forced each flush stays the sampled read-site blame: query blame --forced), and no layout-thrashing detector. See query blame --dirtied and query span run.";
}

export function firefoxBreakdown(): string {
  return "CPU time breakdown (js/style/layout/browser/gc/idle bar) on Firefox: idle comes from the per-sample CPU-usage signal (threadCPUDelta ~0 == the thread was descheduled/waiting; 95.7% on a pure-wait window), and style/layout from the sampled Layout-category frames. The slices reconcile (Σ slices = the sampled window). NOT in the bar: paint (off-main-thread compositor work, a side track shown separately, never summed), and on tiny workloads a ~1ms sampling floor. Layout/style/forced-layout counts come from the Reflow/Styles markers, not this bar.";
}

export function firefoxNoCpuBreakdown(): string {
  return "No CPU time breakdown on Firefox: this Gecko dump carries no per-sample threadCPUDelta CPU signal (an older recording, or the profiler ran without the `cpu` feature), so idle cannot be told from engine work and a bar would fabricate it. CPU self-time (scriptingMs, query cpu) is still measured.";
}

// --- Chrome rung ladder ---

/** Default rung (rung 1): sampler only, no trace, so no rendering counts. */
export function defaultRung(): string {
  return "Default mode (rung 1): CPU sampler only, no DevTools trace, for the cleanest wall. Rendering counts (layout/style/paint/forced) and their durations are NOT measured here and are reported as not-measured (—), never 0. Add --breakdown for the reconciling js/style/layout/paint/gc/other/idle bar, or --deep for exact counts and forced-layout blame.";
}

export function cpuSamplerOnDefaultRung(): string {
  return "The CPU sampler perturbs per-iteration wall by ~1% on this rung: it is systematic, so it cancels in `diff`. Use --precise-wall for a sampler-off benchmark wall (no CPU model).";
}

/** Rung 3 (--deep): full trace, sampler off; exact counts + blame, durations suppressed. */
export function deepRung(): string {
  return "Deep mode (rung 3): full trace (.stack + invalidationTracking) with the CPU sampler OFF. Exact counts (layout/style/paint/forced), forced-layout blame, the invalidation rollup and long tasks are the product. Slice DURATIONS (layoutMs/styleMs/paintMs) are suppressed (—): the .stack trace inflates them (style up to +38%), and a distorted number is worse than none. Run --breakdown for the reconciling bar and a CPU model; span wall (the window width) is still honest here.";
}

/** --precise-wall: rung 1 minus the sampler. */
export function preciseWall(): string {
  return "Precise-wall mode: the CPU sampler is OFF for a pristine benchmark wall (the ~1% the sampler costs). No CPU model and no rendering counts — the wall is the only product. Drop --precise-wall for the four-slice CPU bar.";
}

// --- Driver step wall ---

/**
 * Which clock priced a driver run's step walls. Never the node-side driver clock: ~20ms of a
 * `page.click` is input dispatch in the tool process, in no renderer timeline (docs/dev/driver-timing.md).
 * "page" is the page's own performance.now() delta between the step marks; "trace" is the trace-clock
 * window between the same marks, which spans navigation and reconciles with the breakdown bar.
 */
export function driverStepWallClock(clock: "trace" | "page"): string {
  return clock === "trace"
    ? "Driver step walls are the trace-clock window between each step's marks (t1-t0 on the renderer's clock), so they price the page's own window and reconcile with the breakdown bar, not the node-side page.click bound."
    : "Driver step walls are the page's own performance.now() delta between each step's marks (no trace on this rung), not the node-side page.click bound (~20ms of which is input dispatch in the tool process; docs/dev/driver-timing.md). A step that navigated cannot be priced this way and reports its wall as not measured — record with --breakdown or --deep for a trace-clock wall that spans navigation.";
}

/** A driver run on the no-trace rung whose steps all navigated: no step wall could be priced. */
export function driverStepWallUnmeasured(): string {
  return "Driver step walls are NOT measured on this run: every step navigated, which resets the page clock, and there is no trace to span it. Record with --breakdown or --deep for a trace-clock wall that survives navigation. See docs/dev/driver-timing.md.";
}

// --- Built-in on-ramp flow (no module) ---

/** No module given: the built-in load flow ran. Names what the single "load" step measures. */
export function onrampBuiltinFlow(): string {
  return "Built-in load flow (no module): one step labeled 'load' navigates to the target (meta.target) inside the run window and settles, so the measured window is the page's own boot. INP is null — a page load has no interaction; pass a module that drives one (measureStep) to measure interactions.";
}

/** The initial navigation failed with a transient cross-process error and was retried on a fresh
 * browser; disclose it so a reader knows the numbers are from a later attempt. */
export function navRetried(retries: number): string {
  const attempts = retries === 1 ? "1 retry" : `${retries} retries`;
  return `NOTE: the navigation failed with a transient cross-process error (e.g. net::ERR_INVALID_HANDLE, common on a heavy cross-origin --url boot) and was retried on a fresh browser (succeeded after ${attempts}). The recorded numbers are from the successful attempt. If this recurs, the target may be rate-limiting or blocking automated loads.`;
}

/** --url named a host with no scheme (localhost:5173); http:// was assumed to reach it. */
export function pageSchemeAssumed(url: string): string {
  return `--url named a host with no scheme, so http:// was assumed: the target is ${url}. Pass an explicit https:// URL if the server is TLS.`;
}

/** Repeated on-ramp on a no-trace rung: the navigating load step has no wall, so --iterations makes
 * no median. Point to --breakdown, whose trace clock spans the navigation. */
export function onrampIterationsNoMedian(iterations: number): string {
  return `--iterations ${iterations} produced no per-iteration wall or median on this rung: the built-in 'load' step navigates, which resets the page clock, and this rung has no trace clock to span the navigation, so every iteration's wall is not measured (—, never 0) and there is no distribution to take a median of. Re-record with --breakdown (or --deep): the trace clock spans the navigation, so the load step gets a real per-iteration wall and median.`;
}

/** Repeated on-ramp: only iteration 1 boots cold, the rest reuse the one browser's caches. */
export function onrampWarmVsCold(iterations: number): string {
  const laterIterations =
    iterations === 2 ? "iteration 2 reuses" : `iterations 2..${iterations} reuse`;
  return `Iteration 1 boots cold, but ${laterIterations} the same browser (one launch per run), so they hit its HTTP/disk cache and warm JIT: the 'load' step's wall median mixes the cold first load with warm reloads. Per-step counts describe iteration 1 (the cold boot). Use --iterations 1 for a purely cold boot.`;
}

// --- Cross-lane ---

export function traceWindowMissing(): string {
  return "WARNING: trace run-window markers (wpd:run:start/end) were not found, so layout/style/paint/forced-layout/invalidation/long-task counts are NOT measured for this run (reported as not measured, never 0). This usually means the trace buffer overflowed or the user_timing category was dropped; re-run, and reduce the measured work if it persists.";
}

/** The run window opened but never closed: the run:start mark was found, run:end was lost. */
export function runEndMarkLost(): string {
  return "WARNING: the run window opened (wpd:run:start) but never closed (wpd:run:end was lost, usually a trace-buffer overflow). Counts remain valid (they window start-onward by design), but the reconciling breakdown bar needs both bounds, so it is absent for this run rather than reported as 0. Re-run, reducing the measured work if it persists.";
}

/** A driver step's end mark was lost: its window (and bar) run to the run end, its wall stays page-clock. */
export function stepEndMarkLost(): string {
  return "WARNING: a driver step's end marker (wpd:step:N:end) was lost from the trace, so that step's counts and breakdown bar window to the run end (an over-estimate of the step), and its wall is the page-clock delta between the step marks rather than the trace-clock window, so it does not reconcile with the step's bar. Usually a trace-buffer overflow; reduce the measured work if it persists.";
}

/**
 * Chrome reported the trace buffer overflowed and dropped events. The trace records on a raised 1 GB
 * buffer (docs/dev/trace-buffer.md), so this only fires on a trace heavy enough to outgrow even that;
 * the dropped events mean trace-derived counts (layout/style/paint/forced, invalidations, long tasks)
 * can UNDERCOUNT and a windowing marker may be lost. Loud, never silent: a dropped event turns an
 * exact count into a plausible wrong one. */
export function traceDataLoss(): string {
  return "WARNING: the trace buffer overflowed and Chrome dropped events (Tracing reported data loss). Layout/style/paint/forced-layout counts, invalidations and long tasks are derived from the trace, so they can UNDERCOUNT here: read them as a floor, not an exact figure. Reduce the measured work (fewer steps per run, or scope the flow); on --deep, the heaviest trace, --breakdown drops the .stack and invalidationTracking categories for a much lighter trace if you do not need forced-layout blame.";
}

/**
 * Some iterations completed and a later one failed; --keep-partial salvaged the completed ones. Names
 * the failed iteration and the step it died on, and states plainly which numbers cover how many
 * iterations, so a salvaged recording is never read as a clean full run. */
export function partialIterations(
  requested: number,
  completed: number,
  failedIteration: number,
  failedStep: string | null,
  reason: string,
): string {
  const at = failedStep ? `at step '${failedStep}'` : "between steps (outside any measureStep)";
  return (
    `WARNING: --keep-partial: iteration ${failedIteration + 1} of ${requested} failed ${at}, so this ` +
    `recording covers only the ${completed} iteration(s) that completed. Per-step walls/INP are the ` +
    `median of those ${completed}; the failed iteration's partial steps were discarded. The run-window ` +
    `bar and counts still include the failed iteration's work up to the failure, so the run total spans ` +
    `${completed} complete iteration(s) plus a partial one. Failure: ${reason}`
  );
}

/** The one templated note: names the slowdown that was applied. */
export function artificialSlowdown(cpuThrottle: number | undefined): string {
  return `Artificial slowdown applied (cpu ${cpuThrottle}x); timings are not comparable to an unthrottled run.`;
}

/** --target node lane (runtime/node.ts). */
export function nodeRuntime(): string {
  return "Node runtime (--target node): in-process V8 sampling profile of run(). CPU only; no DOM, layout, paint, or invalidation is measured. Self-time ms come from the profiler's own clock.";
}

/** --disable-browser-sandbox in effect: Chrome ran with --no-sandbox (record.ts). */
export function browserSandboxDisabled(): string {
  return "WARNING: --disable-browser-sandbox launched Chrome with --no-sandbox: the renderer runs without OS-level process containment. Only safe in a trusted, isolated environment; do not combine it with --user-data-dir or a non-loopback --url.";
}

/** chrome-headless-shell missing => fell back to new-headless (browser/launch.ts). */
export function shellFallback(): string {
  return "WARNING: chrome-headless-shell is not installed, so this run fell back to new-headless (~60Hz frames): wall/INP carry the ~16.6ms one-frame floor instead of ~8.3ms. Install it with `npx puppeteer browsers install chrome-headless-shell`, or pass --headless-mode new to select new-headless deliberately.";
}
