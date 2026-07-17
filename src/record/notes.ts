/**
 * The catalog of every fixed `meta.notes` string, one function per note. The TRIGGER logic (which
 * note fires, and when) stays at the call sites in src/record/*, runtime/node.ts and
 * browser/launch.ts; only the WORDING lives here, so a reader auditing what the tool can say reads
 * one file, and an e2e test matching a note substring has one place the text can change.
 *
 * The two algorithmic notes -- count scope (passplan.ts `noteCountScope`) and sourcemap resolution
 * (record.ts `sourcemapNote`) -- are not here: their text is assembled from the pass plan and the
 * diagnostics, so wording and logic are inseparable and already live in their own generators.
 */

// --- --breakdown lane ---

export function breakdownNoProfile(): string {
  return "WARNING: --breakdown could not be computed: the fused pass produced no CPU sampler profile, so no per-span breakdown was generated.";
}

export function breakdownShape(): string {
  return "Breakdown mode: ONE fused pass (light trace + CPU sampler) yields a reconciling js/style/layout/paint/gc/other/idle bar per span (Σ slices + idle = wall). Timing rides this pass, so per-iteration wall is ~2-5% above a pristine timing pass.";
}

export function breakdownForcedNotMeasured(): string {
  return "NOT measured in breakdown mode: forced-layout count and forced-layout blame (they need the `.stack` trace category, which this mode drops); reported as 'not measured', never 0. Run the default mode (no --breakdown) for forced-layout blame.";
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
  return "Firefox backend (WebDriver BiDi): no CDP, so no exact counters and no CPU/network throttling. Wall timing rides performance.now (directional).";
}

export function firefoxRenderingCountsMeasured(): string {
  return "Rendering counts on Firefox: layoutCount/styleCount/forcedLayoutCount ARE measured, from the Gecko profiler's Reflow/Styles markers. Gecko batches layout differently than Chrome, so these are approximate and NOT comparable to Chrome's CDP counts: read them against another Firefox run. NOT measured at all and reported as 0: paintCount, invalidation counts, long tasks (counted from the DevTools trace, which Gecko has no equivalent of), and scriptingMs. A 0 in those means unmeasured, not clean.";
}

export function firefoxRenderingCountsDisabled(): string {
  return "Rendering counts on Firefox come from the Gecko profiler pass, which this run disabled (cpuProfile:false). EVERY rendering count here is reported as 0 because nothing counted them, not because the page did no work: layout/style/paint, forced layout, invalidations, long tasks, scriptingMs. Wall timing and INP are real.";
}

export function firefoxInp(): string {
  return "INP IS measured on Firefox (in-page Event Timing, the same observer Chrome uses). The two engines' values are not interchangeable: both span the interaction through the next paint and round to 8 ms, but Firefox reports a systematically lower number for identical work because presentation delay differs by engine. Compare a browser against itself across a change, not one engine against the other.";
}

export function firefoxNoCpuBreakdown(): string {
  return "No CPU time breakdown (js/browser/gc/idle bar) on Firefox: the Gecko profile does not record idle samples (a fully-idle window reads as 0 idle), so a bar here would fabricate the idle slice. CPU self-time (scriptingMs, query cpu) is still measured. Use --target chrome for the breakdown.";
}

// --- Chrome default lane ---

export function timingInstrumented(): string {
  return "Single-pass mode (--no-isolate): instrumentation was active during timing, so per-iteration timings are inflated. Drop --no-isolate for trustworthy timing.";
}

export function timingClean(): string {
  return "Timing/stats come from a low-overhead pass with tracing OFF.";
}

export function paintCountsSeparatePass(): string {
  return "Paint & invalidation counts come from a separate heavy-instrumentation pass; do not compare durations across the two.";
}

export function noTracePass(): string {
  return "No trace pass ran (--no-trace): counts come from CDP only. Paint, forced-layout, invalidation and long-task detail is NOT collected and is reported as 0 — that means unmeasured, not clean.";
}

export function cpuSamplerOnTimingPass(): string {
  return "The CPU sampler ran during the timing pass, which inflates per-iteration wall by roughly 10%: it is systematic, so it cancels in `diff`, but use --no-cpu-profile for absolute wall numbers.";
}

export function noCpuModelNoIsolate(): string {
  return "No CPU model in this run: --no-isolate collapses to the single trace pass, and CPU sampling during tracing would inflate self-time by ~21% (trace instrumentation is billed to the JS frame that triggered it). Drop --no-isolate to get a CPU model, or add --no-trace to sample without tracing.";
}

// --- Cross-lane ---

export function traceWindowMissing(): string {
  return "WARNING: trace run-window markers (wpd:run:start/end) were not found, so paint/forced-layout/invalidation/long-task counts are NOT measured for this run and are reported as 0. CDP counters (layout/style/scripting) are unaffected. This usually means the trace buffer overflowed or the user_timing category was dropped; re-run, and reduce work or raise --settle if it persists.";
}

/** The one templated note: names the slowdown that was applied. */
export function artificialSlowdown(
  cpuThrottle: number | undefined,
  network: string | undefined,
): string {
  const parts = [cpuThrottle ? `cpu ${cpuThrottle}x` : null, network].filter(Boolean).join(", ");
  return `Artificial slowdown applied (${parts}); timings are not comparable to an unthrottled run.`;
}

/** --target node lane (runtime/node.ts). */
export function nodeRuntime(): string {
  return "Node runtime (--target node): in-process V8 sampling profile of run(). CPU only; no DOM, layout, paint, or invalidation is measured. Self-time ms come from the profiler's own clock.";
}

/** chrome-headless-shell missing => fell back to new-headless (browser/launch.ts). */
export function shellFallback(): string {
  return "WARNING: chrome-headless-shell is not installed, so this run fell back to new-headless (~60Hz frames): wall/INP carry the ~16.6ms one-frame floor instead of ~8.3ms. Install it with `npx puppeteer browsers install chrome-headless-shell`, or pass --headless-mode new to select new-headless deliberately.";
}
