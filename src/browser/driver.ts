import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import type { CDPSession, Page } from "puppeteer";
import { SETTLE_SOURCE } from "./settle.js";
import { snapshotMetricsIfAvailable, metricsDelta } from "../metrics/cdp.js";
import { duplicateLabelError } from "../trace/steps.js";

export interface DriverStep {
  /** this step's position WITHIN its iteration; the same label gets the same index every time */
  index: number;
  /**
   * Which timed iteration produced this step (0-based). Optional so a programmatic caller may
   * hand-build single-iteration steps; absent is read as 0 (see mergeSteps).
   */
  iteration?: number;
  /**
   * "prepare" for a step measured inside prepare(), which runs ONCE before the timed loop, so it
   * has one sample no matter what --iterations says. Absent means "timed". Kept distinct rather
   * than folded into `iteration` because the two ask different questions: a prepare step is not
   * iteration 0 of anything, and treating it as such made the idempotency check see an extra label
   * in iteration 0 and fail every repeated run whose prepare() measured something.
   */
  phase?: "prepare" | "timed";
  /**
   * Unique within the pass: the N in this step's `wpd:step:N` marks. Distinct from `index`
   * because a repeated flow measures "mount" once per iteration, and two windows sharing a mark
   * name could not be told apart in the trace. Absent falls back to `index`, which is the same
   * number whenever only one iteration ran.
   */
  markIndex?: number;
  label: string;
  wallMs: number;
  inpMs: number | null;
  cdpDelta: Record<string, number>;
}

export interface DriverResult {
  steps: DriverStep[];
  lifecycle: string[];
  /** CDP counters snapshotted at run:start, i.e. AFTER prepare() and warmup, so the overall
   * recording's authoritative counts exclude setup DOM work (consistent with bench mode). */
  cdpBefore: Record<string, number>;
  /**
   * Counters right after the FIRST timed iteration. The overall counts are read against this
   * rather than the post-run snapshot so they describe one iteration's work instead of scaling
   * with --iterations. Absent when only one iteration ran (nothing to bracket).
   */
  cdpAfterFirstIteration?: Record<string, number>;
  /** teardown to run AFTER tracing stops, so it's kept out of the measured window */
  cleanup?: () => unknown | Promise<unknown>;
}

export interface DriverOptions {
  /** timed repetitions of run(); each re-measures every step and appends a wall sample */
  iterations: number;
  /** untimed repetitions of run() before the timed loop, excluded from marks/counters/samples */
  warmup: number;
}

/** "Step is done" override: a selector to wait for, a predicate/async fn, or a promise. */
export type Until = string | (() => unknown | Promise<unknown>) | Promise<unknown> | undefined;

interface StepOpts {
  until?: Until;
}

/**
 * Driver (puppeteer) mode: the user's module runs in Node and `run` receives
 * `{ page, ctx, measureStep }`. Define each step with:
 *
 *   await measureStep('label', () => page.click('#x'))
 *   await measureStep({ label, action, until })
 *
 * Each step is wrapped in wpd:step:N marks, settled (or awaited via
 * `until`), bracketed by CDP metric snapshots, and assigned a per-step INP.
 */
export async function runDriver(
  page: Page,
  client: CDPSession | null,
  absModule: string,
  fnName: string,
  options: DriverOptions = { iterations: 1, warmup: 0 },
): Promise<DriverResult> {
  // Firefox (BiDi) has no CDP session: per-step CDP counter deltas are unavailable, so they
  // read as {}. Everything else (marks, settle, INP observer) works over BiDi.
  const snapshot = () => snapshotMetricsIfAvailable(client);
  const mod: any = await import(pathToFileURL(absModule).href);
  const pick = (...names: string[]) => {
    for (const name of names) if (typeof mod[name] === "function") return mod[name];
    return undefined;
  };
  const run = pick(fnName, "run") ?? (typeof mod.default === "function" ? mod.default : undefined);
  if (!run) throw new Error(`Driver module has no '${fnName}' / 'run' / default export.`);
  const prepare = pick("prepare", "setup", "beforeAll");
  const cleanup = pick("cleanup", "teardown", "afterAll");

  const lifecycle: string[] = [];
  if (prepare) lifecycle.push("prepare");
  lifecycle.push("run");
  if (cleanup) lifecycle.push("cleanup");

  const mark = (markName: string) => page.evaluate((name) => performance.mark(name), markName);
  const settle = () => page.evaluate(SETTLE_SOURCE);
  const paintFlush = () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );

  // Observe interaction event-timing so we can attribute INP per step. Installed via
  // evaluateOnNewDocument so it re-arms on every navigation (a step that navigates would
  // otherwise wipe the observer and lose INP for all later steps). durationThreshold:16
  // is the spec floor for 'event'; sub-16ms interactions are not reported by the API.
  const installInpObserver = () => {
    const win = window as any;
    win.__cpInp = [];
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) win.__cpInp.push((entry as any).duration);
      }).observe({ type: "event", durationThreshold: 16, buffered: true } as any);
    } catch {
      /* event-timing unsupported */
    }
  };
  await page.evaluateOnNewDocument(installInpObserver);
  await page.evaluate(installInpObserver);

  async function waitDone(until: Until): Promise<void> {
    if (until == null) return void (await settle());
    if (typeof until === "string") await page.waitForSelector(until);
    else if (typeof until === "function") await (until as () => unknown)();
    else if (typeof (until as Promise<unknown>).then === "function") await until;
    else return void (await settle());
    await paintFlush();
  }

  const steps: DriverStep[] = [];
  // Labels must be unique within ONE iteration, not within the run: a repeated flow measures
  // "mount" once per iteration, and those are the samples, not a collision. Reset per iteration.
  let usedLabels = new Set<string>();
  let indexInIteration = 0;
  let markIndex = 0;
  let iteration = 0;
  let phase: "prepare" | "timed" = "prepare";
  // Where each iteration's `index` counter restarts. prepare() may measure steps too, and those
  // keep the low indices for the whole run; resetting to 0 instead would give the first run step
  // the same index as a prepare step, and `window.measure` (built from index) would then name a
  // mark belonging to the other one.
  let timedIndexBase = 0;
  // Warmup runs the flow for its side effects only (JIT, caches, first-paint work), so steps are
  // executed but not marked, snapshotted or recorded.
  let recording = true;
  // cleanup() is deliberately called by record.ts AFTER tracing stops, so a step measured there
  // can never have a trace window; see the throw in measure().
  let inCleanup = false;

  async function measure(label: string, action: () => unknown, until: Until): Promise<void> {
    if (inCleanup) {
      throw new Error(
        `measureStep(${JSON.stringify(label)}) cannot be used in cleanup(): teardown runs after ` +
          `tracing has stopped, so the step is never traced and its layout/paint/forced-layout ` +
          `counts would all read 0 as if it were clean. Measure it in run() instead.`,
      );
    }
    if (!recording) {
      // Warmup: do the work, measure nothing. The action still runs because the flow's later
      // steps depend on it having happened.
      await action();
      await waitDone(until);
      return;
    }
    // Fail here rather than at the cross-pass merge: this fires on the offending call, before
    // the rest of the flow and the second pass have run.
    if (usedLabels.has(label)) throw duplicateLabelError(label);
    usedLabels.add(label);
    const index = indexInIteration++;
    const stepMark = markIndex++;
    await page.evaluate(() => ((window as any).__cpInp = []));
    await mark(`wpd:step:${stepMark}:start`);
    const before = await snapshot();
    const t0 = performance.now();
    await action();
    await waitDone(until);
    const wallMs = performance.now() - t0;
    const after = await snapshot();
    await mark(`wpd:step:${stepMark}:end`);
    // Event-Timing entries reach the observer on a later task, after the frame is
    // presented. Flush a frame + a macrotask so a slow interaction's entry lands before
    // we read it, rather than being dropped or misattributed to the next step. null
    // (not 0) means "no interaction measured"; keep them distinct.
    const inp = (await page.evaluate(
      () =>
        new Promise<number | null>((resolve) => {
          requestAnimationFrame(() =>
            setTimeout(() => {
              const inpDurations = (window as any).__cpInp as number[];
              resolve(inpDurations && inpDurations.length ? Math.max(...inpDurations) : null);
            }, 0),
          );
        }),
    )) as number | null;
    steps.push({
      index,
      iteration,
      phase,
      markIndex: stepMark,
      label,
      wallMs,
      inpMs: inp,
      cdpDelta: metricsDelta(before, after),
    });
  }

  // measureStep('label', fn, {until})  OR  measureStep({label, action, until})
  function measureStep(
    labelOrConfig: string | { label: string; action: () => unknown; until?: Until },
    action?: () => unknown,
    opts?: StepOpts,
  ): Promise<void> {
    if (typeof labelOrConfig === "string") return measure(labelOrConfig, action!, opts?.until);
    return measure(labelOrConfig.label, labelOrConfig.action, labelOrConfig.until);
  }

  const ctx: Record<string, unknown> = {};
  if (prepare) await prepare({ page, ctx, measureStep });
  // Anything prepare() measured owns indices 0..n-1 permanently; the timed loop starts after them
  // and restarts there every iteration, so a label's index is the same in every iteration.
  phase = "timed";
  timedIndexBase = indexInIteration;

  // Warmup, before the counters and marks: its DOM work must not land in the counts, and its
  // wall must not land in the samples. prepare() already ran, so warmup repeats the flow itself.
  recording = false;
  for (let warm = 0; warm < options.warmup; warm++) await run({ page, ctx, measureStep });
  recording = true;

  // Snapshot CDP counters at run:start, after prepare() and warmup, so setup DOM work isn't
  // folded into the overall recording's authoritative counts (matches bench mode).
  const cdpBefore = await snapshot();
  await mark("wpd:run:start");

  // The loop that turns a single sample into a distribution. run() is called once per iteration
  // and re-measures every step, so a label's samples are its own repetitions.
  //
  // There is deliberately no reset hook: a flow that needs a fresh page per iteration expresses
  // it as a bare page.goto() inside run() outside any measureStep, which is strictly more
  // expressive than a boolean (it makes the fresh/in-place choice per step, not per run) and
  // needs no API at all.
  let cdpAfterFirstIteration: Record<string, number> | undefined;
  for (iteration = 0; iteration < options.iterations; iteration++) {
    usedLabels = new Set<string>();
    indexInIteration = timedIndexBase;
    await run({ page, ctx, measureStep });
    // Close the counts bracket: the overall counts describe ONE iteration, so they mean the same
    // at any --iterations, while wall keeps every sample. Only meaningful past the first.
    if (iteration === 0 && options.iterations > 1) cdpAfterFirstIteration = await snapshot();
  }
  await mark("wpd:run:end");

  // Don't run cleanup here; return it so record.ts can call it after tracing stops,
  // keeping teardown work out of the measured window.
  return {
    steps,
    lifecycle,
    cdpBefore,
    cdpAfterFirstIteration,
    cleanup: cleanup
      ? () => {
          inCleanup = true;
          return cleanup({ page, ctx, measureStep });
        }
      : undefined,
  };
}
