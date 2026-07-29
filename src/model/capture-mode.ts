// Capture-mode predicates over `meta.capture` (the scalar naming the one capture mode). Pure,
// no imports, so any layer can ask "did the gecko pass run" or "is this the firefox --deep report"
// without pulling in a heavier module (and without an import cycle).

/** The gecko pass ran (firefox, any reporting tier): the deep event log, counts and blame exist. */
export function isGeckoCaptureMode(capture: string): boolean {
  return capture === "gecko" || capture === "gecko-deep";
}

/**
 * Firefox --deep: the reporting tier that surfaces Gecko's native cause-stack write identity as a
 * first-invalidation-only dirtied-by report. The capture is the SAME one gecko pass in every firefox
 * capture mode -- this only requests the write-side annotation Gecko already carries, never chrome's
 * exact counts, forced-by read side, or the thrash detector.
 */
export function isFirefoxDeep(capture: string): boolean {
  return capture === "gecko-deep";
}

/**
 * Does this recording carry a read-site blame / event log a reader can answer from? --deep (chrome)
 * and firefox always store it. --breakdown stores a SAMPLED read-site log ONLY when the trace emitted
 * per-sample executing lines; record() records that durable capability as `blameSemantic ===
 * "flush-site"` and CLEARS it when the browser emitted none. So gate breakdown on the capability, never
 * on `capture === "breakdown"` alone: an old --breakdown recording, or one whose browser emitted no
 * lines, holds an EMPTY event log that must degrade to unavailable, never read as a clean run.
 */
export function hasBlameEventLog(capture: string, blameSemantic: string | undefined): boolean {
  if (capture === "deep" || isGeckoCaptureMode(capture)) return true;
  return capture === "breakdown" && blameSemantic === "flush-site";
}

/**
 * Does this chrome capture mode store the FULL trace event log in the recording (every event, its
 * `.stack` and invalidationTracking `args` kept for blame)? Only `--deep`: the parsed event array and
 * the recording's serialized JSON both scale with trace size, so a heavy `--deep` journey is the one
 * that can OOM the parse or overrun the ~512MB JSON-string ceiling. `--breakdown` stores a small
 * sampled read-site log, the trace-free modes store nothing, and firefox's gecko-derived events reach
 * the recording through the dump path, not this chrome trace parse.
 */
export function storesFullTraceEventLog(mode: string): boolean {
  return mode === "deep";
}

/**
 * Above this many raw trace bytes, a chrome `--deep` stored event log cannot serialize: the densest
 * forced-layout shape crosses the ~512MB single-JSON-string ceiling at ~190MB of trace [measured], so a
 * 180MB floor refuses before the parse (which OOMs on a heavier trace) can run. A sparser production
 * journey serializes a larger trace (~271MB [measured]), so this is a conservative floor across shapes,
 * not the exact failure point of any one workload. See docs/dev/trace-buffer.md.
 */
export const DEEP_EVENT_LOG_TRACE_BYTE_CEILING = 180 * 1024 * 1024;

/**
 * Preflight: a chrome `--deep` capture whose raw trace exceeds the ceiling will store an event log
 * that cannot serialize, so refuse now (right after capture, before the parse can OOM) rather than
 * after a full parse or a raw out-of-memory crash. Returns true = refuse. Only a mode that stores the
 * full trace event log is gated; every other mode parses past the ceiling by design.
 */
export function deepEventLogWouldOverflow(mode: string, traceByteLength: number): boolean {
  return storesFullTraceEventLog(mode) && traceByteLength > DEEP_EVENT_LOG_TRACE_BYTE_CEILING;
}

/**
 * The per-row confidence marker a `query blame --forced` view row carries (BlameEntry.lowConfidence).
 * Three-way, so a consumer can tell a sampled-confident row from a not-sampled one:
 *   - undefined: NOT a sampled row (chrome `--deep` exact `.stack`, or firefox) -- the field is absent,
 *     never a misleading `false`.
 *   - false: a sampled row (chrome `--breakdown`) with at least one flush WIDER than one sampler
 *     interval, so the sampled read line is confident.
 *   - true: a sampled row every flush of which was NARROWER than one interval, so the read line can lag
 *     one statement or land on an adjacent line.
 * `sampledLane` is whether this recording samples the read site (chrome `--breakdown`); `confident` and
 * `lowConfidence` are the per-line tallies of wide vs sub-interval sampled flushes.
 */
export function blameRowLowConfidence(
  sampledLane: boolean,
  confident: number,
  lowConfidence: number,
): boolean | undefined {
  if (!sampledLane) return undefined;
  return confident === 0 && lowConfidence > 0;
}
