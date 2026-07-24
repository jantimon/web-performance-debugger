// Capture-mode predicates over `meta.passes` (a one-element array naming the one capture mode). Pure,
// no imports, so any layer can ask "did the gecko pass run" or "is this the firefox --deep report"
// without pulling in a heavier module (and without an import cycle).

/** The gecko pass ran (firefox, any reporting tier): the deep event log, counts and blame exist. */
export function isGeckoCaptureMode(passes: readonly string[]): boolean {
  return passes.includes("gecko") || passes.includes("gecko-deep");
}

/**
 * Firefox --deep: the reporting tier that surfaces Gecko's native cause-stack write identity as a
 * first-invalidation-only dirtied-by report. The capture is the SAME one gecko pass in every firefox
 * capture mode -- this only requests the write-side annotation Gecko already carries, never chrome's
 * exact counts, forced-by read side, or the thrash detector.
 */
export function isFirefoxDeep(passes: readonly string[]): boolean {
  return passes.includes("gecko-deep");
}

/**
 * Does this recording carry a read-site blame / event log a reader can answer from? --deep (chrome)
 * and firefox always store it. --breakdown stores a SAMPLED read-site log ONLY when the trace emitted
 * per-sample executing lines; record() records that durable capability as `blameSemantic ===
 * "flush-site"` and CLEARS it when the browser emitted none. So gate breakdown on the capability, never
 * on `passes.includes("breakdown")` alone: an old --breakdown recording, or one whose browser emitted no
 * lines, holds an EMPTY event log that must degrade to unavailable, never read as a clean run.
 */
export function hasBlameEventLog(
  passes: readonly string[],
  blameSemantic: string | undefined,
): boolean {
  if (passes.includes("deep") || isGeckoCaptureMode(passes)) return true;
  return passes.includes("breakdown") && blameSemantic === "flush-site";
}
