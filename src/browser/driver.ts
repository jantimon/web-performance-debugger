import { pathToFileURL } from "node:url";
import type { Page } from "puppeteer";
import { SETTLE_SOURCE } from "./settle.js";
import { duplicateLabelError } from "../trace/steps.js";
import type { InteractionTiming } from "../model/recording.js";

export interface DriverStep {
  /** this step's position WITHIN its iteration; the same label gets the same index every time */
  index: number;
  /**
   * Which clock priced `wallMs`: "trace" when the trace window between the step's marks priced it,
   * "page" when it is the page's own performance.now delta. Absent when wallMs is null. A "page"
   * wall beside a trace-clock breakdown does not reconcile with the bar.
   */
  wallClock?: "trace" | "page";
  /**
   * Which timed iteration produced this step (0-based). Optional so a programmatic caller may
   * hand-build single-iteration steps; absent is read as 0 (see mergeSteps).
   */
  iteration?: number;
  /**
   * "prepare" for a step measured inside prepare(), which runs ONCE before the timed loop, so it
   * has one sample no matter what --iterations says. Absent means "timed". Kept distinct rather
   * than folded into `iteration` because the two ask different questions: a prepare step is not
   * iteration 0 of anything, and treating it as such would make the idempotency check see an extra
   * label in iteration 0 and fail every repeated run whose prepare() measured something.
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
  /**
   * The step's wall on the clock the rung has: the page's own `performance.now()` delta between the
   * step's marks (this field, `pageWallMs`), overridden by the trace-clock window between the same
   * marks when a trace was captured (--breakdown/--deep). Never the node-side `performance.now()`
   * around `page.click`, which measures the tool process: ~20ms of that is input dispatch in no
   * renderer timeline (docs/dev/driver-timing.md). Null when neither clock can price the step (a
   * navigating step on the no-trace default rung: a new document resets the page clock, so the two
   * marks no longer share one, and there is no trace to span it).
   */
  wallMs: number | null;
  /**
   * The page-side `performance.now()` delta between this step's marks, measured in-page. Null when
   * the step navigated (the marks land on documents with different `timeOrigin`, so their delta is
   * meaningless). `wallMs` starts here and is upgraded to the trace-clock window when a trace exists.
   */
  pageWallMs: number | null;
  inpMs: number | null;
  /** in-page CWV split of `inpMs`; null when no interaction crossed the 16ms Event Timing floor */
  interaction: InteractionTiming | null;
}

/** One Event Timing entry, as read back out of the page. */
export interface RawEventTiming {
  startTime: number;
  processingStart: number;
  processingEnd: number;
  duration: number;
  /** 0 for events that are not part of an interaction (pointerover, mouseover, ...) */
  interactionId: number;
}

/**
 * Split the worst interaction's latency into the three CWV parts.
 *
 * Group by `interactionId`, take the worst group, then keep only the entries in it that share the
 * group's LONGEST duration. That last step is the subtle one, and skipping it produced nonsense.
 * One interaction can span more than one paint: on a held click (measured, `delay: 250`)
 * `pointerdown` painted at 43.3 with `duration: 24` while `pointerup`/`click` painted at 336.1 with
 * `duration: 64`. Mixing them -- reading `startTime` off `pointerdown` and `duration` off `click` --
 * reported `processingMs: 297.5` and `presentationDelayMs: -241.8` for a 45ms handler.
 *
 * The max-duration entries are the right anchor because `duration` IS the interaction's latency to
 * its paint, and INP is that maximum: describing that journey describes the number being reported.
 * Anchoring on the earliest event instead would price `pointerdown`'s own paint and lose the click
 * handler entirely (15.7ms of a measured 45.3). Durations are 8ms multiples, so equality here needs
 * no epsilon; entries reaching the same paint from starts 0.1ms apart still share one duration
 * (measured: a plain click's pointerdown/pointerup/click all read 64).
 *
 * Non-negative by construction: paintTime is clamped to be >= processingStart, and processingEnd is
 * clamped to be <= paintTime, mirroring the same two guards in web-vitals.
 *
 * Returns null when nothing carries an interactionId. That is not a failure and must not be 0: a
 * programmatic step (`page.evaluate`) fires untrusted events, which Event Timing does not observe at
 * all (measured: zero entries), and an interaction faster than the spec's 16ms floor produces none.
 */
export function interactionBreakdown(entries: RawEventTiming[]): InteractionTiming | null {
  const groups = new Map<number, RawEventTiming[]>();
  for (const entry of entries) {
    if (!entry.interactionId) continue;
    const group = groups.get(entry.interactionId) ?? [];
    group.push(entry);
    groups.set(entry.interactionId, group);
  }
  let worstGroup: RawEventTiming[] | null = null;
  let worstDuration = -1;
  for (const group of groups.values()) {
    const duration = Math.max(...group.map((entry) => entry.duration));
    if (duration > worstDuration) {
      worstDuration = duration;
      worstGroup = group;
    }
  }
  if (!worstGroup) return null;

  // Only the events that reached the paint this interaction is measured by.
  const atWorstPaint = worstGroup.filter((entry) => entry.duration === worstDuration);
  const startTime = Math.min(...atWorstPaint.map((entry) => entry.startTime));
  const processingStart = Math.min(...atWorstPaint.map((entry) => entry.processingStart));
  // max(): a handler that starts after its own frame deadline would otherwise push presentation
  // delay negative. min(): processing cannot outlast the paint it is being measured against.
  const paintTime = Math.max(startTime + worstDuration, processingStart);
  const processingEnd = Math.min(
    Math.max(...atWorstPaint.map((entry) => entry.processingEnd)),
    paintTime,
  );
  return {
    inputDelayMs: processingStart - startTime,
    processingMs: processingEnd - processingStart,
    presentationDelayMs: paintTime - processingEnd,
  };
}

/** A timed iteration failed partway and --keep-partial salvaged the ones that completed. */
export interface PartialRun {
  /** iterations the caller asked for */
  requested: number;
  /** iterations that ran run() to completion (and whose steps are kept) */
  completed: number;
  /** 0-based index of the iteration that threw */
  failedIteration: number;
  /** label of the measureStep in progress when it threw, or null (it failed between steps) */
  failedStep: string | null;
  /** the thrown error's message */
  reason: string;
}

export interface DriverResult {
  steps: DriverStep[];
  lifecycle: string[];
  /** teardown to run AFTER tracing stops, so it's kept out of the measured window */
  cleanup?: () => unknown | Promise<unknown>;
  /** set when --keep-partial salvaged a run whose later iteration failed */
  partial?: PartialRun;
}

export interface DriverOptions {
  /** timed repetitions of run(); each re-measures every step and appends a wall sample */
  iterations: number;
  /** untimed repetitions of run() before the timed loop, excluded from marks/counters/samples */
  warmup: number;
  /**
   * Keep the iterations that completed when a LATER one fails, instead of aborting the whole run.
   * Only salvages when at least one full iteration completed; a failure in iteration 0 (a broken
   * flow) still throws. The failed iteration's partial steps are discarded and disclosed loudly.
   */
  keepPartial?: boolean;
}

/** "Step is done" override: a selector to wait for, a predicate/async fn, or a promise. */
export type Until = string | (() => unknown | Promise<unknown>) | Promise<unknown> | undefined;

interface StepOpts {
  until?: Until;
}

/**
 * The built-in on-ramp flow (no user module): navigate to `navigateUrl` inside one measured step so
 * the page's own boot lands in the run window (goto-inside-a-step tracing). See docs/dev/driver-timing.md.
 */
export interface OnrampFlow {
  navigateUrl: string;
}

/**
 * Driver (puppeteer) mode: the user's module runs in Node and `run` receives
 * `{ page, ctx, measureStep }`. Define each step with:
 *
 *   await measureStep('label', () => page.click('#x'))
 *   await measureStep({ label, action, until })
 *
 * Each step is wrapped in wpd:step:N marks, settled (or awaited via
 * `until`), and assigned a per-step INP. Per-step rendering counts come from the trace window this
 * pass captures (--breakdown/--deep), not from CDP: there is one pass, and the counters are gone.
 */
export async function runDriver(
  page: Page,
  absModule: string | undefined,
  fnName: string,
  options: DriverOptions = { iterations: 1, warmup: 0 },
  onramp?: OnrampFlow,
): Promise<DriverResult> {
  let run: (arg: any) => unknown;
  let prepare: ((arg: any) => unknown) | undefined;
  let cleanup: ((arg: any) => unknown) | undefined;
  if (onramp) {
    // Built-in flow: one "load" step that navigates to the target. No prepare/cleanup. The default
    // settle (rAF+idle, twice) flushes the boot's paints after the load event, so the window is the
    // page's own load-to-settle. A navigating step has a null page-clock wall (the two marks sit on
    // documents with different timeOrigins); a trace rung prices it off the trace window instead.
    run = ({
      measureStep,
    }: {
      measureStep: (label: string, action: () => unknown) => Promise<void>;
    }) =>
      measureStep("load", () =>
        page.goto(onramp.navigateUrl, { waitUntil: "load", timeout: 30000 }),
      );
  } else {
    if (!absModule)
      throw new Error("runDriver needs a module path unless a built-in flow is provided.");
    const mod: any = await import(pathToFileURL(absModule).href);
    const pick = (...names: string[]) => {
      for (const name of names) if (typeof mod[name] === "function") return mod[name];
      return undefined;
    };
    run = pick(fnName, "run") ?? (typeof mod.default === "function" ? mod.default : undefined);
    if (!run) throw new Error(`Driver module has no '${fnName}' / 'run' / default export.`);
    prepare = pick("prepare", "setup", "beforeAll");
    cleanup = pick("cleanup", "teardown", "afterAll");
  }

  const lifecycle: string[] = [];
  if (prepare) lifecycle.push("prepare");
  lifecycle.push("run");
  if (cleanup) lifecycle.push("cleanup");

  const mark = (markName: string) => page.evaluate((name) => performance.mark(name), markName);
  // Emit a step's edge mark AND read the page's own clock at that instant: `now` is
  // `performance.now()` (the page-clock timestamp of the mark) and `origin` is `timeOrigin` (which
  // changes on navigation, so a step that navigated is detectable and its page-clock wall refused).
  const stepClock = (markName: string) =>
    page.evaluate((name) => {
      performance.mark(name);
      return { now: performance.now(), origin: performance.timeOrigin };
    }, markName) as Promise<{ now: number; origin: number }>;
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
        for (const entry of list.getEntries()) {
          const event = entry as any;
          // The whole entry, not just duration: processingStart/End are what split the latency into
          // input delay / processing / presentation, and unlike duration they are not rounded to 8ms.
          win.__cpInp.push({
            startTime: event.startTime,
            processingStart: event.processingStart,
            processingEnd: event.processingEnd,
            duration: event.duration,
            interactionId: event.interactionId ?? 0,
          });
        }
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
  // The measureStep in progress, for --keep-partial's disclosure: which step an iteration died on.
  // Set before the action runs, cleared once the step is recorded; null means "between steps".
  let activeStepLabel: string | null = null;

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
    activeStepLabel = label;
    const index = indexInIteration++;
    const stepMark = markIndex++;
    await page.evaluate(() => ((window as any).__cpInp = []));
    const startClock = await stepClock(`wpd:step:${stepMark}:start`);
    await action();
    await waitDone(until);
    const endClock = await stepClock(`wpd:step:${stepMark}:end`);
    // The page's own view of [start mark, end mark]. Null across a navigation (the two marks are on
    // documents with different timeOrigins, so their performance.now() delta is not one interval);
    // record.ts upgrades this to the trace-clock window when a trace was captured.
    const pageWallMs = startClock.origin === endClock.origin ? endClock.now - startClock.now : null;
    // Event-Timing entries reach the observer on a later task, after the frame is
    // presented. Flush a frame + a macrotask so a slow interaction's entry lands before
    // we read it, rather than being dropped or misattributed to the next step. null
    // (not 0) means "no interaction measured"; keep them distinct.
    const observed = (await page.evaluate(
      () =>
        new Promise<RawEventTiming[]>((resolve) => {
          requestAnimationFrame(() =>
            setTimeout(() => resolve(((window as any).__cpInp as RawEventTiming[]) ?? []), 0),
          );
        }),
    )) as RawEventTiming[];
    // INP stays max-over-every-entry, deliberately: Chrome emits the whole pointer sequence with
    // every entry sharing one duration to the same next paint, and Firefox emits only the events
    // that did work, so this finds the interaction's latency in both. Verified in both engines:
    // docs/dev/gecko-profile-format.md. The breakdown below needs the interactionId grouping the
    // spec defines; the headline does not, and narrowing it here would change a measured behaviour
    // for no gain.
    const inp = observed.length ? Math.max(...observed.map((entry) => entry.duration)) : null;
    const interaction = interactionBreakdown(observed);
    steps.push({
      index,
      iteration,
      phase,
      markIndex: stepMark,
      label,
      wallMs: pageWallMs,
      ...(pageWallMs != null ? { wallClock: "page" as const } : {}),
      pageWallMs,
      inpMs: inp,
      interaction,
    });
    activeStepLabel = null;
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

  // prepare() and warmup have run; mark the run window so setup DOM work stays outside it (the
  // trace counts, when a trace is captured, are windowed start-onward from this mark).
  await mark("wpd:run:start");

  // The loop that turns a single sample into a distribution. run() is called once per iteration
  // and re-measures every step, so a label's samples are its own repetitions.
  //
  // There is deliberately no reset hook: a flow that needs a fresh page per iteration expresses
  // it as a bare page.goto() inside run() outside any measureStep, which is strictly more
  // expressive than a boolean (it makes the fresh/in-place choice per step, not per run) and
  // needs no API at all.
  let partial: PartialRun | undefined;
  for (iteration = 0; iteration < options.iterations; iteration++) {
    usedLabels = new Set<string>();
    indexInIteration = timedIndexBase;
    try {
      await run({ page, ctx, measureStep });
    } catch (error) {
      // A flow that never completed a full iteration (iteration 0 failed, or --keep-partial was not
      // set) has nothing honest to salvage: rethrow so a broken flow is a hard error, not a quietly
      // empty recording. When --keep-partial is set and an earlier iteration DID complete, keep those
      // and disclose the failure loudly (record.ts turns `partial` into a note + stderr warning).
      if (!options.keepPartial || iteration === 0) throw error;
      // Discard the failed iteration's partial steps: they are the trailing entries (steps push in
      // order), and a half-measured iteration would fail the same-labels-each-iteration check and
      // skew a label's median with a sample that measured less work than it claims.
      while (steps.length && steps[steps.length - 1].iteration === iteration) steps.pop();
      partial = {
        requested: options.iterations,
        completed: iteration,
        failedIteration: iteration,
        failedStep: activeStepLabel,
        reason: error instanceof Error ? error.message : String(error),
      };
      break;
    }
  }
  await mark("wpd:run:end");

  // Don't run cleanup here; return it so record.ts can call it after tracing stops,
  // keeping teardown work out of the measured window.
  return {
    steps,
    lifecycle,
    ...(partial ? { partial } : {}),
    cleanup: cleanup
      ? () => {
          inCleanup = true;
          return cleanup({ page, ctx, measureStep });
        }
      : undefined,
  };
}
