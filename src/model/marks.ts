/**
 * Canonical `wpd:*` UserTiming mark and measure names, the coupling point the trace/profile pipeline
 * windows on. Every NODE-SIDE consumer (trace/parse.ts, profile/gecko.ts, src/record/*,
 * runtime/node.ts) imports these so a rename lands in one place.
 *
 * The page-serialized functions in browser/harness.ts and browser/driver.ts CANNOT import this
 * module: they are stringified into `page.evaluate` and run in the browser, where nothing from
 * Node's module graph exists. They keep literal copies by necessity, and a unit test pins those
 * literals to these constants so the two cannot drift.
 */

/** Mark emitted before the timed loop; its timestamp is the run window start. */
export const RUN_START_MARK = "wpd:run:start";
/** Mark emitted after the timed loop; its timestamp is the run window end. */
export const RUN_END_MARK = "wpd:run:end";
/** Measure spanning [RUN_START_MARK, RUN_END_MARK]; also the RecordingWindow.measure name. */
export const RUN_MEASURE = "wpd:run";
/** Prefix shared by every wpd:* mark/measure, for excluding wpd's own measures from user measures. */
export const WPD_MARK_PREFIX = "wpd:";

/** The per-step mark base `wpd:step:N`; the driver appends `:start`/`:end` for the step edges. */
export const stepMark = (index: number | string): string => `wpd:step:${index}`;

/** Parse a `wpd:step:N:start|end` edge mark into its step index and edge, or null if it is not one. */
export function matchStepEdgeMark(name: string): { index: number; edge: "start" | "end" } | null {
  const match = /^wpd:step:(\d+):(start|end)$/.exec(name);
  return match ? { index: Number(match[1]), edge: match[2] as "start" | "end" } : null;
}

/** True for the run/step start|end marks the windowing pipeline keys on (not wpd:iter:* or the
 * wpd:run measure). */
export function isRunOrStepEdgeMark(name: string): boolean {
  return /^wpd:(run|step:\d+):(start|end)$/.test(name);
}
