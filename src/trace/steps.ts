import type { DriverStep } from "../browser/driver.js";
import type { StepWindow } from "./parse.js";

/**
 * A step's trace window keyed by label instead of index. Step indices are only meaningful
 * WITHIN the pass that produced them: every pass replays the flow in a fresh browser with its
 * own counter starting at 0, so index N in the trace pass and index N in the timing pass are
 * the same step only by coincidence. Re-key to the label before matching across passes.
 */
export interface LabelledWindow {
  label: string;
  startTs: number;
  endTs: number | null;
}

/** A step merged across passes: label/timing from the timing pass, window from the trace pass. */
export interface MergedStep {
  index: number;
  label: string;
  wallMs: number;
  inpMs: number | null;
  cdpDelta: Record<string, number>;
  startTs: number | null;
  endTs: number | null;
}

/**
 * Shared by runDriver (which fails fast, on the offending measureStep call) and mergeSteps
 * (the library-boundary backstop), so both refuse a repeated label with the same explanation.
 */
export function duplicateLabelError(label: string): Error {
  return new Error(
    `Duplicate step label ${JSON.stringify(label)}. Step labels must be unique within a run: ` +
      `the label is the only key that identifies a step across measurement passes, and two steps ` +
      `sharing one would join the wrong timing to the wrong trace. Give them distinct labels ` +
      `(e.g. ${JSON.stringify(`${label}@small`)} and ${JSON.stringify(`${label}@large`)}).`,
  );
}

/** runDriver is the primary gate (it fails on the offending call); this is the backstop for
 * programmatic callers that hand-build steps and never go through it. */
function assertUniqueLabels(labelled: { label: string }[]): void {
  const seen = new Set<string>();
  for (const entry of labelled) {
    if (seen.has(entry.label)) throw duplicateLabelError(entry.label);
    seen.add(entry.label);
  }
}

/**
 * Join one pass's trace windows to its own step labels. Sound only because both sides come from
 * the SAME runDriver call, where the index is a shared counter; this is the only place where
 * index-keyed pairing is valid. Windows whose index has no step are dropped: the trace can lose
 * marks (buffer overflow) but cannot invent them, so an unmatched window is not a step we ran.
 */
export function labelWindows(steps: DriverStep[], windows: StepWindow[]): LabelledWindow[] {
  const labelByIndex = new Map(steps.map((step) => [step.index, step.label]));
  const labelled: LabelledWindow[] = [];
  for (const window of windows) {
    const label = labelByIndex.get(window.index);
    if (label == null) continue;
    labelled.push({ label, startTs: window.startTs, endTs: window.endTs });
  }
  return labelled;
}

function describeDivergence(timingLabels: string[], tracedLabels: string[]): string {
  const traced = new Set(tracedLabels);
  const timed = new Set(timingLabels);
  const missing = timingLabels.filter((label) => !traced.has(label));
  const extra = tracedLabels.filter((label) => !timed.has(label));
  const parts: string[] = [];
  if (missing.length) parts.push(`only in the timing pass: ${missing.join(", ")}`);
  if (extra.length) parts.push(`only in the trace pass: ${extra.join(", ")}`);
  return parts.join("; ");
}

/**
 * Merge the timing pass's steps (label, wall, INP, clean CDP delta) with the trace pass's
 * windows, BY LABEL.
 *
 * Divergence throws rather than degrading. An unmatched step would get a null window, which the
 * caller's event filter turns into an empty event slice, which buildSummary reports as zero
 * layouts/paints/forced-layouts. Those zeros are indistinguishable from a genuinely clean step,
 * so `assert --max-forced 0` would pass on a step that was never measured. The two-pass merge
 * assumes an idempotent flow; this is where that assumption is checked instead of assumed.
 *
 * `tracedWindows` of undefined is NOT divergence: it means the detail pass collected no windows
 * at all (a lane without tracing, or a trace that lost its markers), so there is nothing to pair
 * with and every step legitimately has no window. That case is the caller's to detect and is
 * reported as a note, not an error.
 */
export function mergeSteps(
  timingSteps: DriverStep[],
  tracedWindows: LabelledWindow[] | undefined,
): MergedStep[] {
  assertUniqueLabels(timingSteps);
  const windowByLabel = new Map((tracedWindows ?? []).map((window) => [window.label, window]));

  if (tracedWindows != null) {
    assertUniqueLabels(tracedWindows);
    const timingLabels = timingSteps.map((step) => step.label);
    const tracedLabels = tracedWindows.map((window) => window.label);
    // Labels are unique on both sides, so set equality is enough: a label-keyed join does not
    // care about order, which is exactly why the label survives across passes and the index does not.
    const diverged =
      timingLabels.length !== tracedLabels.length ||
      timingLabels.some((label) => !windowByLabel.has(label));
    if (diverged) {
      throw new Error(
        `The timing and trace passes recorded different steps (${describeDivergence(timingLabels, tracedLabels)}). ` +
          `Each pass replays the flow in a fresh browser, so run() must take the same path every time: ` +
          `make the flow idempotent (no conditional or randomised measureStep calls), or record a single ` +
          `pass with --no-isolate. If the flow IS idempotent, the trace lost some wpd:step markers ` +
          `(an overflowing trace buffer drops events) -- reduce the work in the run or raise --settle.`,
      );
    }
  }

  return timingSteps.map((step): MergedStep => {
    const window = tracedWindows == null ? undefined : windowByLabel.get(step.label);
    return {
      index: step.index,
      label: step.label,
      wallMs: step.wallMs,
      inpMs: step.inpMs,
      cdpDelta: step.cdpDelta, // clean, from the timing pass
      startTs: window?.startTs ?? null,
      endTs: window?.endTs ?? null,
    };
  });
}
