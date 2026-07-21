// The one gate every artifact reader passes through: an on-disk file whose `meta.schemaVersion` is
// not this build's SCHEMA_VERSION is REJECTED, loudly, rather than mis-parsed against a shape it was
// never written to: an older wpd's stored shape differs, and reading it as the current shape would
// silently return nulls and zeros, the quiet-wrong-answer this tool refuses. So the reader stops and
// tells the user to re-record.

import { SCHEMA_VERSION } from "../schema.js";

/**
 * Throw unless `schemaVersion` is exactly this build's `SCHEMA_VERSION`. `file` names the offending
 * artifact in the message. The guidance branches on which side is behind: an OLDER artifact re-records
 * under this build; a NEWER one (its epoch parses above this build's) means the reader is behind, so
 * upgrade wpd rather than re-record (re-recording would throw away the newer evidence). An absent or
 * non-numeric version cannot be ordered against this build's epoch, so it falls to a neutral
 * re-record refusal, never a best-effort parse.
 */
export function assertSchemaVersion(schemaVersion: string | undefined, file: string): void {
  if (schemaVersion === SCHEMA_VERSION) return;
  const found = schemaVersion == null ? "<none>" : `"${schemaVersion}"`;
  // Order only on an all-digit epoch: Number.parseInt would read "3-draft" as 3 and mis-order it as
  // an older recording, so a non-numeric version falls through to the neutral branch instead.
  const epochOf = (value: string): number =>
    /^\d+$/.test(value) ? Number.parseInt(value, 10) : NaN;
  const foundEpoch = schemaVersion == null ? NaN : epochOf(schemaVersion);
  const thisEpoch = epochOf(SCHEMA_VERSION);
  const prefix = `${file}: unreadable artifact (schema ${found}; this build reads schema "${SCHEMA_VERSION}"). `;
  if (Number.isInteger(foundEpoch) && Number.isInteger(thisEpoch) && foundEpoch > thisEpoch)
    throw new Error(prefix + `It was recorded by a newer wpd; upgrade wpd to read it.`);
  if (Number.isInteger(foundEpoch) && Number.isInteger(thisEpoch) && foundEpoch < thisEpoch)
    throw new Error(prefix + `It was recorded by an older wpd; re-record with this version.`);
  throw new Error(prefix + `It carries a different schema epoch; re-record with this version.`);
}

/**
 * Throw unless the parsed object is shaped like a recording artifact (a `spans` array). The schema
 * gate cannot tell artifact KINDS of the same epoch apart: a sibling `.cpu.json` carries the same
 * schemaVersion but is a CpuModel, and reading it positionally as a recording crashes on the first
 * missing field. Callers that expect a recording pass through here after the version gate.
 */
export function assertRecordingArtifact(
  parsed: { meta?: { schemaVersion?: string; kind?: string }; spans?: unknown },
  file: string,
): void {
  assertSchemaVersion(parsed?.meta?.schemaVersion, file);
  // A run-group manifest carries the same schemaVersion but is a different artifact kind (no spans);
  // reading it as a recording would crash on the first missing field. Name the fix rather than let
  // the shape check below print the generic sibling-file message.
  if (parsed?.meta?.kind === "run-group")
    throw new Error(
      `${file} is a run-group manifest, not a single recording. Pass one of its members, or use a ` +
        `group-aware verb (query spans/span, assert, diff) with the manifest or 'latest'.`,
    );
  if (!Array.isArray(parsed?.spans))
    throw new Error(
      `${file} is not a recording artifact (no spans array); pass the recording, not a sibling ` +
        `.cpu.json/.cpuprofile file (or use 'latest').`,
    );
}

/**
 * Throw unless the parsed object is shaped like a run-group manifest (schema-current, `meta.kind ===
 * "run-group"`, a `members` array). The version gate cannot tell artifact KINDS of one epoch apart, so
 * a group reader passes through here after it: reading a Recording as a manifest, or a manifest an
 * older wpd could not have written, must refuse rather than crash positionally.
 */
export function assertGroupArtifact(
  parsed: { meta?: { schemaVersion?: string; kind?: string }; members?: unknown },
  file: string,
): void {
  assertSchemaVersion(parsed?.meta?.schemaVersion, file);
  if (parsed?.meta?.kind !== "run-group" || !Array.isArray(parsed?.members))
    throw new Error(
      `${file} is not a run-group manifest (expected meta.kind "run-group" and a members array). ` +
        `Pass the .group.json manifest, or a single recording to the non-group verbs.`,
    );
}
