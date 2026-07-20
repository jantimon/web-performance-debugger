import type { DriverStep } from "../browser/driver.js";
import type { StepWindow } from "./parse.js";
import type { InteractionTiming, StepLoaf } from "../model/recording.js";

/**
 * A step's trace window keyed by label instead of index. The one pass produces both the step
 * timings (wall/INP) and, when it captures a trace, the step windows; re-keying to the label is what
 * lets `mergeSteps` group a label's per-iteration samples (a repeated "mount" is samples, not a
 * collision), since a label recurs every iteration while its index does not.
 */
export interface LabelledWindow {
  label: string;
  /** which timed iteration produced this window; only iteration 0 is used for counts/blame.
   * Optional for hand-built windows, where absent is read as 0. A prepare() step is iteration 0
   * too (it runs once, before the loop), so this filter keeps its window without a phase of its own. */
  iteration?: number;
  startTs: number;
  endTs: number | null;
}

/** A step merged across iterations: label/timing from the driver-side samples, window from the trace. */
export interface MergedStep {
  index: number;
  label: string;
  /**
   * This step's wall for every timed iteration, in iteration order. Length 1 unless --iterations
   * repeated the flow. Raw samples, not just the aggregate: a median hides the bimodality that
   * says "the first iteration was cold", which is usually the finding.
   */
  perIteration: number[];
  /** the median of `perIteration`; identical to the single sample when there is only one. Null when
   * no iteration could be priced (a navigating step in a no-trace capture mode; see DriverStep.wallMs). */
  wallMs: number | null;
  /** the clock every walled sample shares: "trace" only when ALL are trace-priced; a single
   * page-clock sample (a lost step-end mark in one iteration) degrades the label to "page", since a
   * median over mixed clocks reconciles with nothing. Absent when wallMs is null. */
  wallClock?: "trace" | "page";
  inpMs: number | null;
  /** each part medianed across the iterations that measured an interaction; null if none did */
  interaction: InteractionTiming | null;
  /**
   * Long Animation Frames from the FIRST timed iteration (Chrome only), matching the per-step counts
   * windowing: LoAF frames carry script attribution that cannot be medianed like a scalar, so the
   * step reports iteration 0's frames rather than a synthetic merge. Absent when none were observed.
   */
  loaf?: StepLoaf;
  startTs: number | null;
  endTs: number | null;
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Shared by runDriver (which fails fast, on the offending measureStep call) and mergeSteps
 * (the library-boundary backstop), so both refuse a repeated label with the same explanation.
 */
export function duplicateLabelError(label: string): Error {
  return new Error(
    `Duplicate step label ${JSON.stringify(label)}. Step labels must be unique within an ` +
      `iteration: the label is the only key that identifies a step across measurement passes, and ` +
      `two steps sharing one would join the wrong timing to the wrong trace. Give them distinct ` +
      `labels (e.g. ${JSON.stringify(`${label}@small`)} and ${JSON.stringify(`${label}@large`)}). ` +
      `Repeating the SAME label across --iterations is fine: those are its samples.`,
  );
}

/**
 * runDriver is the primary gate (it fails on the offending call); this is the backstop for
 * programmatic callers that hand-build steps and never go through it.
 *
 * Uniqueness is per ITERATION, not per run: with --iterations, "mount" legitimately appears once
 * per iteration and those are its samples. Two "mount"s in the SAME iteration are a collision:
 * one label would join the wrong timing to the wrong trace.
 */
function assertUniqueLabels(labelled: { label: string; iteration?: number }[]): void {
  const seen = new Set<string>();
  for (const entry of labelled) {
    const key = `${entry.iteration ?? 0}\u0000${entry.label}`;
    if (seen.has(key)) throw duplicateLabelError(entry.label);
    seen.add(key);
  }
}

/**
 * Every iteration must measure the same steps, or a label's samples describe different amounts of
 * work while presenting as one distribution. Ten "mount" samples where two iterations skipped it
 * is a median over 8 labelled 10, which is the kind of plausible-looking wrong number this repo
 * refuses to emit. Same idempotency requirement the cross-pass merge already has, checked here
 * because --iterations is what makes it a within-pass concern too.
 */
function assertSameLabelsEachIteration(steps: DriverStep[]): void {
  const byIteration = new Map<number, string[]>();
  // prepare() runs once, before the loop, so a step it measured legitimately appears in no
  // iteration but the first. Counting it here would fail every repeated run whose prepare()
  // measured anything, blaming the user's flow for a rule this check invented.
  for (const step of steps.filter((entry) => entry.phase !== "prepare")) {
    const iterationIndex = step.iteration ?? 0;
    const labels = byIteration.get(iterationIndex) ?? [];
    labels.push(step.label);
    byIteration.set(iterationIndex, labels);
  }
  const iterations = [...byIteration.keys()].sort((left, right) => left - right);
  if (iterations.length < 2) return;
  const first = byIteration.get(iterations[0])!;
  const expected = [...first].sort();
  for (const iterationIndex of iterations.slice(1)) {
    const actual = [...byIteration.get(iterationIndex)!].sort();
    const differs =
      actual.length !== expected.length || actual.some((label, at) => label !== expected[at]);
    if (differs) {
      const missing = expected.filter((label) => !actual.includes(label));
      const extra = actual.filter((label) => !expected.includes(label));
      const detail = [
        missing.length ? `missing: ${missing.join(", ")}` : null,
        extra.length ? `unexpected: ${extra.join(", ")}` : null,
      ]
        .filter(Boolean)
        .join("; ");
      throw new Error(
        `Iteration ${iterationIndex} measured different steps than iteration ${iterations[0]} (${detail}). ` +
          `With --iterations, run() must take the same path every time: each label's samples are its ` +
          `own repetitions, so a step that only runs sometimes would report a median over fewer ` +
          `samples than it claims. Make the flow idempotent (no conditional or randomised ` +
          `measureStep calls), or drop --iterations.`,
      );
    }
  }
}

/**
 * Join one pass's trace windows to its own step labels. Sound only because both sides come from
 * the SAME runDriver call, where the index is a shared counter; this is the only place where
 * index-keyed pairing is valid. Windows whose index has no step are dropped: the trace can lose
 * marks (buffer overflow) but cannot invent them, so an unmatched window is not a step we ran.
 */
export function labelWindows(steps: DriverStep[], windows: StepWindow[]): LabelledWindow[] {
  // Keyed by markIndex, not index: with --iterations the same `index` recurs every iteration,
  // while the mark name is what the trace actually carries and is unique within the pass. Falls
  // back to `index` for hand-built steps (see assertUniqueLabels): for a single-iteration flow the
  // two counters are identical, and defaulting keeps such a caller working instead of silently
  // matching nothing and reporting every step as unwindowed.
  const stepByMark = new Map(steps.map((step) => [step.markIndex ?? step.index, step]));
  const labelled: LabelledWindow[] = [];
  for (const window of windows) {
    const step = stepByMark.get(window.index);
    if (step == null) continue;
    labelled.push({
      label: step.label,
      iteration: step.iteration ?? 0,
      startTs: window.startTs,
      endTs: window.endTs,
    });
  }
  return labelled;
}

function describeDivergence(timingLabels: string[], tracedLabels: string[]): string {
  const traced = new Set(tracedLabels);
  const timed = new Set(timingLabels);
  const missing = timingLabels.filter((label) => !traced.has(label));
  const extra = tracedLabels.filter((label) => !timed.has(label));
  const parts: string[] = [];
  if (missing.length) parts.push(`only in the step timings: ${missing.join(", ")}`);
  if (extra.length) parts.push(`only in the trace windows: ${extra.join(", ")}`);
  return parts.join("; ");
}

/**
 * Merge the pass's steps (label, wall, INP) with its own trace windows, BY LABEL.
 *
 * Divergence throws rather than degrading. An unmatched step would get a null window, which the
 * caller's event filter turns into an empty event slice, which buildSummary reports as zero
 * layouts/paints/forced-layouts. Those zeros are indistinguishable from a genuinely clean step,
 * so `assert --max-forced 0` would pass on a step that was never measured. It can only mean the
 * trace lost some wpd:step markers (a buffer overflow), so it is a hard error, not a silent degrade.
 *
 * `tracedWindows` of undefined is NOT divergence: it means the pass captured no trace at all (the
 * default/precise-wall capture mode, or firefox), so there is nothing to pair with and every step
 * legitimately has no window. That case is the caller's to detect and is reported as a note.
 */
export function mergeSteps(
  timingSteps: DriverStep[],
  tracedWindows: LabelledWindow[] | undefined,
  /** Chrome reported the trace buffer dropped events. When set, a step/window mismatch is KNOWN to be
   * an overflow, so the message says so outright instead of also offering the idempotency cause. */
  traceDataLoss = false,
): MergedStep[] {
  assertUniqueLabels(timingSteps);
  assertSameLabelsEachIteration(timingSteps);
  // Per-step counts and blame describe the FIRST timed iteration, so only its windows are paired.
  // Later iterations' windows exist (the one pass runs every iteration for wall) but are dropped:
  // a step's trace-derived counts window to a single iteration so they never scale.
  // Iteration 0 covers both the first timed iteration and anything prepare() measured (it runs
  // once, before the loop, so its steps are iteration 0 as well). A prepare step's window is the
  // only one it has: dropping it would leave the step unwindowed and report its counts as 0,
  // which reads as "clean" rather than "not measured".
  const isFirstPass = (entry: { iteration?: number }) => (entry.iteration ?? 0) === 0;
  const firstIterationWindows = tracedWindows?.filter(isFirstPass);
  const windowByLabel = new Map((firstIterationWindows ?? []).map((win) => [win.label, win]));

  if (tracedWindows != null) {
    assertUniqueLabels(tracedWindows);
    const timingLabels = timingSteps.filter(isFirstPass).map((step) => step.label);
    const tracedLabels = (firstIterationWindows ?? []).map((window) => window.label);
    // Labels are unique on both sides, so set equality is enough: a label-keyed join does not
    // care about order, which is exactly why the label survives across passes and the index does not.
    const diverged =
      timingLabels.length !== tracedLabels.length ||
      timingLabels.some((label) => !windowByLabel.has(label));
    if (diverged) {
      const divergence = describeDivergence(timingLabels, tracedLabels);
      throw new Error(
        traceDataLoss
          ? `The trace buffer overflowed and dropped wpd:step markers (Chrome reported data loss), so the ` +
              `trace and the step timings recorded different steps (${divergence}). The counts cannot be ` +
              `trusted here (dropped events undercount), so this is a hard error, not a degraded recording. ` +
              `--deep is the heaviest trace; reduce the measured work in the run (fewer steps per run, or ` +
              `scope the flow), or use --breakdown if you do not need forced-layout blame.`
          : `The step timings and trace windows recorded different steps (${divergence}). ` +
              `With --iterations, run() must take the same path every time: make the flow idempotent (no ` +
              `conditional or randomised measureStep calls). Otherwise the trace lost some wpd:step markers ` +
              `(an overflowing trace buffer drops events) -- reduce the work in the run.`,
      );
    }
  }

  // One MergedStep per LABEL, not per measureStep call: with --iterations the same label recurs
  // every iteration, and those repetitions are the samples that make its median mean anything.
  const byLabel = new Map<string, DriverStep[]>();
  for (const step of timingSteps) {
    const group = byLabel.get(step.label) ?? [];
    group.push(step);
    byLabel.set(step.label, group);
  }

  const merged: MergedStep[] = [];
  for (const [label, group] of byLabel) {
    const ordered = [...group].sort(
      (left, right) => (left.iteration ?? 0) - (right.iteration ?? 0),
    );
    const first = ordered[0];
    const window = tracedWindows == null ? undefined : windowByLabel.get(label);
    // A step whose wall could not be priced (navigation in a no-trace capture mode) contributes no sample,
    // rather than a fabricated 0 or a null poisoning the median.
    const perIteration = ordered
      .map((step) => step.wallMs)
      .filter((wallMs): wallMs is number => wallMs != null);
    // INP is the median across iterations, not the worst: the worst would climb with --iterations
    // (more samples, more chances at a slow one), so raising --iterations to gain confidence would
    // report a worse INP for unchanged code. Counts stay per-iteration for the same reason.
    const inpSamples = ordered
      .map((step) => step.inpMs)
      .filter((inpMs): inpMs is number => inpMs != null);
    // Each part medianed independently, for the same reason INP is: taking the worst would make
    // every part climb with --iterations. They can therefore sum to slightly more or less than the
    // INP median, which is honest -- three medians are not one interaction, and pretending
    // otherwise would mean picking one iteration's breakdown and calling it typical.
    const measured = ordered
      .map((step) => step.interaction)
      .filter((entry): entry is InteractionTiming => entry != null);
    const interaction: InteractionTiming | null = measured.length
      ? {
          inputDelayMs: median(measured.map((entry) => entry.inputDelayMs)),
          processingMs: median(measured.map((entry) => entry.processingMs)),
          presentationDelayMs: median(measured.map((entry) => entry.presentationDelayMs)),
        }
      : null;
    const walled = ordered.filter((step) => step.wallMs != null);
    const wallClock = walled.length
      ? walled.every((step) => step.wallClock === "trace")
        ? ("trace" as const)
        : ("page" as const)
      : undefined;
    merged.push({
      index: first.index,
      label,
      perIteration,
      wallMs: perIteration.length ? median(perIteration) : null,
      ...(wallClock ? { wallClock } : {}),
      inpMs: inpSamples.length ? median(inpSamples) : null,
      interaction,
      ...(first.loaf ? { loaf: first.loaf } : {}),
      startTs: window?.startTs ?? null,
      endTs: window?.endTs ?? null,
    });
  }
  return merged;
}
