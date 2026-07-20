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
