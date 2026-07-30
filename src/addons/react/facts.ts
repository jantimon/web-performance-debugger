// The `react` addon's fact shapes: build-INDEPENDENT React signals wpd can state as measurement, not
// editorial. Every field is measured; an absent field means the signal was not observed on this lane,
// never a fabricated zero. Exported BY the addon so the core Span type references them only through
// the `addons.react` slot (model/addon.ts). See docs/dev/react-attribution.md.

/**
 * react-dom server-render self-time rolled onto a minimal allowlist of stable server-phase anchor
 * names (node lane). [probe] React 19 production SSR ships these unmangled, so the rollup resolves in
 * production on 19 with no dev build and no sourcemaps; React 18 production SSR is mangled, so the
 * anchors do not resolve and this fact is ABSENT there (honestly, never a zero). See ReactAddon's
 * SERVER_PHASE_ANCHORS and docs/dev/react-attribution.md#the-anchor-allowlist-is-fragile-across-majors.
 */
export interface ReactPhaseRollup {
  /** react-dom self-time attributed to the recognised server-phase anchors, ms (sum of `anchors`) */
  totalMs: number;
  /** per-anchor self-time, ms, descending; only anchors that actually resolved a frame appear */
  anchors: { name: string; selfMs: number }[];
}

/**
 * React facts attached to a span's `addons.react` slot. Detection + commit counts are build-
 * independent and exact-tier; `phases` is the node-lane server-phase rollup. Detection facts ride the
 * RUN span (they describe the whole run); `commitCount` rides whichever span's window observed the
 * commits (the run span, or a driver step). `phases` rides the run span (node lane).
 */
export interface ReactFacts {
  /** did the pre-load hook see React register a renderer? Browser lanes; absent on node (no page) */
  detected?: boolean;
  /** the reconciler's React version (e.g. "19.2.0"); absent when not detected */
  version?: string;
  /** the renderer package the reconciler registered (e.g. "react-dom"); absent when not detected */
  rendererPackageName?: string;
  /**
   * Build flavor from the reconciler's `bundleType` (DEV=1 -> "development", PROD=0 -> "production").
   * The cheapest dev/prod signal (no fiber walk). A development build prices validation bookkeeping a
   * shipped build never pays, so this is the field a reader checks before trusting magnitudes. Absent
   * when not detected.
   */
  build?: "development" | "production";
  /**
   * Commits committed in this span's window: `onCommitFiberRoot` fires once per committed update, so
   * this is an exact-count-tier metric, build-independent (measured equal on dev and production). Only
   * a count -- per-commit `actualDuration` is dev-gated and stays out. Absent on a lane with no hook
   * (node) or a window that committed nothing.
   */
  commitCount?: number;
  /**
   * React hydration recoverable errors that reached wpd's window `error` listener during the run.
   * React's DEFAULT `onRecoverableError` routes through `reportError`, which dispatches a window `error`
   * event; a hydration mismatch fires one. Exact count when present, build-independent (production fires
   * it too). Absent is NOT proof of clean hydration: an app that supplies its own `onRecoverableError`
   * (or `hydrateRoot` option) replaces the default and suppresses the event, so wpd sees nothing.
   * Browser lanes only (rides the run span). See docs/dev/react-attribution.md.
   */
  hydrationRecoverableErrors?: number;
  /** The first hydration recoverable error's message (truncated); present only alongside
   * `hydrationRecoverableErrors`, to identify the mismatch. */
  firstHydrationError?: string;
  /** node lane: react-dom server-render self-time by phase anchor; absent when no anchor resolved */
  phases?: ReactPhaseRollup;
}
