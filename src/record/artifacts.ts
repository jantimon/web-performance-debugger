import { serialize, type Format } from "../output/format.js";
import { writeFileAtomic } from "../model/atomic-write.js";
import type { CpuModel, Recording } from "../model/recording.js";

// A JSON string longer than 0x1fffffe8 (~512MB) cannot exist: JSON.stringify throws RangeError
// "Invalid string length" (V8 code ERR_STRING_TOO_LONG). The trace itself now parses past that ceiling
// event by event, but a --deep/firefox recording stores the full event log (every trace event, `.stack`
// and invalidation args kept for blame), so a journey heavy enough to grow the trace past ~512MB grows
// its stored event log past the same limit. Name that failure rather than surface a bare RangeError.
function isStringTooLongError(error: unknown): boolean {
  return (
    error instanceof RangeError &&
    (error.message.includes("Invalid string length") ||
      (error as { code?: string }).code === "ERR_STRING_TOO_LONG")
  );
}

// Pure artifact writers: they take already-built model objects and put them on disk. No browser
// handles, no meta mutation, so a fixture test can drive them directly. The collapse leaves two
// writers: the one default artifact (Span[] + summary + meta, with the deep event log under --deep)
// and the resolved CPU model. The `query spans`/`query span <label>` views are derived from the
// recording at read time, so there is no separate step-index file to write.

/** Serialize a recording to `outPath` (atomic: temp file + rename, so a killed write leaves the
 * previous recording intact rather than a half-written one). */
export async function writeRecording(
  outPath: string,
  recording: Recording,
  format: Format,
): Promise<void> {
  let body: string;
  try {
    body = serialize(recording, format);
  } catch (error) {
    if (!isStringTooLongError(error)) throw error;
    throw new Error(
      `The recording holds ${recording.events.length.toLocaleString()} trace events whose JSON is ` +
        `larger than the ~512MB a single string can hold, so the artifact could not be written. --deep ` +
        `stores the full event log (.stack + invalidationTracking) for forced-layout blame; reduce the ` +
        `measured work (fewer steps per run, or scope the flow), or record with --breakdown (a lighter ` +
        `trace that stores no event log) if you do not need blame.`,
    );
  }
  await writeFileAtomic(outPath, body);
}

/** Serialize the resolved CPU model to `cpuModelPath` (atomic, same reason as writeRecording). */
export async function writeCpuModel(
  cpuModelPath: string,
  cpuModel: CpuModel,
  format: Format,
): Promise<void> {
  await writeFileAtomic(cpuModelPath, serialize(cpuModel, format));
}
