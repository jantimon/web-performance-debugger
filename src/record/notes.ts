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
  return "WARNING: --breakdown could not be computed: the fused pass produced no CPU sampler profile, so no per-span breakdown was generated.";
}

export function breakdownShape(): string {
  return "Breakdown mode: ONE fused pass (light trace + CPU sampler) yields a reconciling js/style/layout/paint/gc/other/idle bar per span (Σ slices + idle = wall). The light trace rides the same pass as the timing, so per-iteration wall is ~2-5% above a sampler-off wall (--precise-wall).";
}

export function breakdownForcedNotMeasured(): string {
  return "NOT measured in breakdown mode: forced-layout count and forced-layout blame (they need the `.stack` trace category, which this mode drops); reported as 'not measured', never 0. Run --deep for forced-layout blame and the dirtied-by/thrash report.";
}

export function breakdownInvalidationNotMeasured(): string {
  return "NOT measured in breakdown mode: invalidation counts (layout/style/paint), because the invalidationTracking category is dropped. A 0 there means unmeasured, not clean. Layout/style/paint counts, long tasks, and CPU self-time ARE measured.";
}

/** WARNING when the breakdown's main thread was picked by activity because the run:start marker was
 * lost. Pushed from buildBreakdowns, not the record() notes block. */
export function breakdownHeuristicMainThread(): string {
  return "WARNING: the wpd:run:start marker was not found, so the breakdown's main thread was picked by layout/paint activity (heuristic). Per-span breakdown attribution may be on the wrong thread.";
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

/** The one templated note: names the slowdown that was applied. */
export function artificialSlowdown(cpuThrottle: number | undefined): string {
  return `Artificial slowdown applied (cpu ${cpuThrottle}x); timings are not comparable to an unthrottled run.`;
}

/** --target node lane (runtime/node.ts). */
export function nodeRuntime(): string {
  return "Node runtime (--target node): in-process V8 sampling profile of run(). CPU only; no DOM, layout, paint, or invalidation is measured. Self-time ms come from the profiler's own clock.";
}

/** chrome-headless-shell missing => fell back to new-headless (browser/launch.ts). */
export function shellFallback(): string {
  return "WARNING: chrome-headless-shell is not installed, so this run fell back to new-headless (~60Hz frames): wall/INP carry the ~16.6ms one-frame floor instead of ~8.3ms. Install it with `npx puppeteer browsers install chrome-headless-shell`, or pass --headless-mode new to select new-headless deliberately.";
}
