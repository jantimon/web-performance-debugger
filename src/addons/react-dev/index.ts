// The `react-dev` addon: dev-build-GATED enrichment. On a chrome `--deep` recording it classifies the
// persisted React Performance-Track `TimeStamp` events (already stored today, kind "other") into
// per-track facts per span window. Gated on the `react` addon having detected a DEVELOPMENT build AND
// entries being present -- a production build emits none, so this addon is honestly absent there. It
// reads what the capture already recorded; it never changes what is captured. The core calls it through
// the Addon interface, never imports its internals. See docs/dev/react-attribution.md

import type { Addon, AddonEnrichContext, AddonSpanWindow } from "../../model/addon.js";
import type { NormalizedEvent, Span } from "../../model/recording.js";
import { classifyReactTracks } from "./classify.js";

const ADDON_NAME = "react-dev";

/** The events inside a span's trace-clock window (inclusive), for scoping the track classification */
function eventsInWindow(events: NormalizedEvent[], window: AddonSpanWindow): NormalizedEvent[] {
  return events.filter(
    (event) =>
      (window.startTs == null || event.ts >= window.startTs) &&
      (window.endTs == null || event.ts <= window.endTs),
  );
}

export const reactDevAddon: Addon = {
  name: ADDON_NAME,

  // No page probe: this addon reads the stored trace event log, not the live page

  enrich(context: AddonEnrichContext): void {
    // Gate 1: the `react` addon must have detected a development/profiling build. A production build
    // writes no track events, so classifying an empty stream would fabricate a zero; absence is honest
    const runReact = context.spans.find((span) => span.kind === "run")?.addons?.react;
    if (runReact?.build !== "development") return;
    // Gate 2: an event log must actually be present (chrome --deep / firefox). Every other capture mode
    // stores none, so there is nothing to classify
    if (context.events.length === 0) return;

    const windowByKey = new Map(
      context.spanWindows.map((window) => [`${window.kind}:${window.label}`, window]),
    );
    const enrichSpan = (span: Span): void => {
      const window = windowByKey.get(`${span.kind}:${span.label}`);
      if (!window) return;
      const facts = classifyReactTracks(eventsInWindow(context.events, window));
      if (!facts) return;
      const slot = (span.addons = span.addons ?? {});
      slot["react-dev"] = facts;
    };
    // Run span (whole window) + each driver step (its own window). Measure spans are the per-component
    // `performance.measure` stream itself, already folded by `query spans`, so they are left alone
    for (const span of context.spans)
      if (span.kind === "run" || span.kind === "step") enrichSpan(span);
  },
};
