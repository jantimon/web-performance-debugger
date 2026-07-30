/**
 * The engine build a recording measured on: the browser version (chrome/firefox) or the node runtime
 * version, raw as the engine reported it plus the parsed major milestone. Kept small and pure so the
 * comparability gate can compare two recordings without re-parsing prose
 */
export interface EngineVersion {
  /** the version string verbatim, e.g. "Chrome/151.0.7922.47", "Firefox/152.0", "v24.13.0" */
  raw: string;
  /** the major milestone parsed from `raw` (151, 152, 24); absent when no integer was found */
  milestone?: number;
}

/**
 * Parse an engine version string into `{ raw, milestone }`. The milestone is the first integer run:
 *   - Chrome `browser.version()` -> "Chrome/151.0.7922.47" -> 151
 *   - Firefox (BiDi) -> "Firefox/152.0" -> 152
 *   - node `process.version` -> "v24.13.0" (or "24.13.0") -> 24
 * A string with no integer yields `{ raw }` alone, so an unrecognised format degrades to a raw-only
 * comparison rather than a fabricated milestone
 */
export function engineVersion(raw: string): EngineVersion {
  const match = raw.match(/\d+/);
  return match ? { raw, milestone: Number(match[0]) } : { raw };
}
