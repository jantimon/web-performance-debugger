/** On-disk artifact schema epoch (major-only), independent of the package version. Stamped
 * into every artifact as `meta.schemaVersion` so files are self-describing; re-exported from
 * index.ts as the public anchor. Bump only on a breaking change to a written shape. */
export const SCHEMA_VERSION = "3" as const;
