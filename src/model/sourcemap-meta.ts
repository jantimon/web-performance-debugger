/** Why a script's sourcemap could not be applied */
export type SourceMapFailure =
  /** the script carries neither a sourceMappingURL comment nor a SourceMap header */
  | "no-sourcemap-url"
  /** the script itself could not be fetched/read */
  | "script-fetch-failed"
  /** the script or its map answered 401/403: it is behind authentication wpd's fetches do not carry */
  | "auth-required"
  /** the script named a map, but it could not be fetched/read */
  | "map-fetch-failed"
  /** the map was fetched but is not valid JSON/not a sourcemap */
  | "map-parse-failed"
  /** the script body exceeded the remote-fetch size cap */
  | "script-too-large"
  /** the map body exceeded the remote-fetch size cap */
  | "map-too-large"
  /** the per-run remote-sourcemap time budget was spent before this fetch */
  | "fetch-budget-exhausted"
  /** the fetch was refused: a non-http(s) scheme, or a private host reached from a public page */
  | "blocked-fetch";

/**
 * What happened to every script a run tried to map. Failure is otherwise invisible: frames keep
 * their minified names and bundle path, so per-package CPU numbers look plausible while
 * attributing everything to the bundle
 */
export interface SourceMapDiagnostics {
  /** scripts a map was attempted for */
  scripts: number;
  /** of those, how many resolved */
  resolved: number;
  /**
   * Of the ones that did NOT resolve, how many look like build output (a minified body).
   *
   * This is the honest trigger for "the package rollup below cannot be believed", and it is a
   * different question from `resolved === 0`. Plain unbundled source has no sourcemap because it
   * needs none: its frames already carry real names and real lines. A minified bundle with no map
   * is the opposite -- every frame keeps its mangled name and its cost rolls up under whatever
   * package.json sits above the bundle, which reads as a real package. 0 here means a missing map
   * cost you nothing. Optional: an older recording may not carry it
   */
  unmappedBundles?: number;
  /**
   * failing script urls grouped by reason. Capped per reason (a page can carry hundreds of
   * unmapped third-party scripts), so `scripts`/`resolved` are the authoritative totals
   */
  failed?: Partial<Record<SourceMapFailure, string[]>>;
  /**
   * Per script whose map RESOLVED but had no mapping for some frame lookups: how many lookups the
   * map answered (`hits`) vs silently dropped (`misses`). Counts are per-lookup, not per distinct
   * position -- the shared resolver queries each frame once per pass (attachStacks x2 +
   * buildCpuModel), so one leaking position lands here once per pass it appears in; the miss share
   * stays honest either way. A miss keeps the frame's minified/remote identity and buckets it by
   * origin, so a map that LOADS fine can still leak attribution -- a different failure from the
   * load-failure reasons in `failed`, and invisible to `resolved` (which counts this script a
   * success). Only scripts with a nonzero miss appear, sorted by miss count and capped, so
   * `scripts`/`resolved` stay authoritative. Optional: an older recording may not carry it
   */
  positionMisses?: Record<string, { misses: number; hits: number }>;
}
