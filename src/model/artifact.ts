// The one gate every artifact reader passes through: an on-disk file whose `meta.schemaVersion` is
// not this build's SCHEMA_VERSION is REJECTED, loudly, rather than mis-parsed against a shape it was
// never written to: an older wpd's stored shape differs, and reading it as the current shape would
// silently return nulls and zeros, the quiet-wrong-answer this tool refuses. So the reader stops and
// tells the user to re-record.

import { SCHEMA_VERSION } from "../schema.js";

/**
 * Throw unless `schemaVersion` is exactly this build's `SCHEMA_VERSION`. `file` names the offending
 * artifact in the message. An absent version (a hand-written or pre-schema file) fails the same way:
 * "I cannot tell what shape this is" is still a refusal, never a best-effort parse.
 */
export function assertSchemaVersion(schemaVersion: string | undefined, file: string): void {
  if (schemaVersion === SCHEMA_VERSION) return;
  const found = schemaVersion == null ? "<none>" : `"${schemaVersion}"`;
  throw new Error(
    `${file}: unreadable artifact (schema ${found}; this build reads schema "${SCHEMA_VERSION}"). ` +
      `It was recorded by an older wpd; re-record with this version.`,
  );
}

/**
 * Throw unless the parsed object is shaped like a recording artifact (a `spans` array). The schema
 * gate cannot tell artifact KINDS of the same epoch apart: a sibling `.cpu.json` carries the same
 * schemaVersion but is a CpuModel, and reading it positionally as a recording crashes on the first
 * missing field. Callers that expect a recording pass through here after the version gate.
 */
export function assertRecordingArtifact(
  parsed: { meta?: { schemaVersion?: string }; spans?: unknown },
  file: string,
): void {
  assertSchemaVersion(parsed?.meta?.schemaVersion, file);
  if (!Array.isArray(parsed?.spans))
    throw new Error(
      `${file} is not a recording artifact (no spans array); pass the recording, not a sibling ` +
        `.cpu.json/.cpuprofile file (or use 'latest').`,
    );
}
