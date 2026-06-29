import { readFileSync } from "node:fs";

// Single source for the package version + cli tool string. Reading package.json at runtime
// (rather than hardcoding) keeps the version from silently desyncing when the changeset
// release bumps it. rootDir is src/, so package.json can't be JSON-imported; the file sits
// one level above dist/version.js both in this repo and in the published package.
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

export const VERSION = manifest.version;

/** The cli's short name (bin + RecordingMeta.tool); not version-bound, so kept literal. */
export const TOOL = "wpd";
