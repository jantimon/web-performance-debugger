// The one gate every artifact reader passes through: an on-disk file whose `meta.schemaVersion` is
// not this build's SCHEMA_VERSION is REJECTED, loudly, rather than mis-parsed against a shape it was
// never written to. A recording, digest view, step view, or CPU model from an older wpd has a
// different stored shape (before the Span-artifact collapse it was three files with different keys);
// reading it as the current shape would silently return nulls and zeros, the quiet-wrong-answer this
// tool refuses. So the reader stops and tells the user to re-record.

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
