// The `react-dev` addon's fact shape: dev-build-GATED enrichment read from the React Performance
// Tracks a development/profiling build writes to the trace (`console.timeStamp` -> `TimeStamp` events
// under `devtools.timeline`, persisted under chrome `--deep`). Absent on a production build (which
// emits none) and outside `--deep` (which stores no event log). Exported BY the addon so the core Span
// references it only through the `addons["react-dev"]` slot. See docs/dev/react-attribution.md.

/** One React Performance-Track bucket within a span window, keyed by the track label the entry
 * carried (a Scheduler lane like "Blocking"/"Transition", or "Components ⚛"). */
export interface ReactTrackBucket {
  /** the entry's `args.data.track` label */
  track: string;
  /** the entry's `args.data.trackGroup` ("Scheduler ⚛" / "Components ⚛") */
  group: string;
  /** how many TimeStamp entries fell in this bucket */
  count: number;
  /** summed entry duration, ms (directional, wall-tier); 0 when the entries were instant markers */
  ms: number;
}

/**
 * React Performance-Track facts for a span window (chrome `--deep`, dev/profiling build only). Reads
 * the persisted `TimeStamp` events wpd already stores -- a classify/parse of `args.data.track`, never a
 * capture change. Gated on the `react` addon having detected a development build AND at least one entry
 * present in the window; absent otherwise (never fabricated). The per-component `performance.measure`
 * stream is a SEPARATE, richer channel already folded by `query spans` as measure spans, so it is not
 * duplicated here.
 */
export interface ReactDevFacts {
  /** total React track TimeStamp entries classified in this span window (>= 1 when present) */
  total: number;
  /** summed entry duration across those entries, ms (directional) */
  totalMs: number;
  /** the entries bucketed by track label, descending by count */
  tracks: ReactTrackBucket[];
}
