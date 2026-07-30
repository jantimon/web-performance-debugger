// The `react` addon: build-INDEPENDENT React facts. Detection metadata + commit counts from the
// pre-load hook (browser lanes), and the react-dom server-phase self-time rollup (node lane). All
// measured; every absence is honest. This module is the ONLY place the `react` fact logic lives -- the
// core calls it through the Addon interface (model/addon.ts), never imports its internals. See
// docs/dev/react-attribution.md.

import type { Addon, AddonEnrichContext, AddonPageInit } from "../../model/addon.js";
import type { Span } from "../../model/recording.js";
import { installReactHook } from "./hook.js";
import { reactServerPhaseRollup } from "./phases.js";
import { isReactHydrationError } from "./hydration.js";
import type { ReactFacts } from "./facts.js";

const ADDON_NAME = "react";

/** Merge facts onto a span's `addons.react` slot without clobbering a fact another phase set. */
function attach(span: Span, facts: ReactFacts): void {
  const slot = (span.addons = span.addons ?? {});
  slot.react = { ...slot.react, ...facts };
}

/** The run-level detection payload the page probe stashed on `window.__wpdAddons.react`, read back at
 * the end of the run. Opaque until shaped here (it crossed the page boundary). */
interface ReactPageData {
  detected?: unknown;
  version?: unknown;
  rendererPackageName?: unknown;
  build?: unknown;
  commitCount?: unknown;
  /** React-authored window `error` messages the page hook captured (react.dev-linked); classified to
   * the hydration ones here. */
  hydrationErrorMessages?: unknown;
}

/** Shape the raw page payload into the detection facts, keeping only fields it actually carried. */
function shapeDetection(raw: ReactPageData): ReactFacts {
  const facts: ReactFacts = { detected: raw.detected === true };
  if (typeof raw.version === "string") facts.version = raw.version;
  if (typeof raw.rendererPackageName === "string")
    facts.rendererPackageName = raw.rendererPackageName;
  if (raw.build === "development" || raw.build === "production") facts.build = raw.build;
  if (typeof raw.commitCount === "number") facts.commitCount = raw.commitCount;
  // Count only the hydration recoverable errors among the captured React errors, and only when at least
  // one landed: an absent count is honest (no hydration error reached the default window channel), never
  // a fabricated 0 that would read as "hydration was clean".
  if (Array.isArray(raw.hydrationErrorMessages)) {
    const hydrationErrors = raw.hydrationErrorMessages.filter(
      (message): message is string => typeof message === "string" && isReactHydrationError(message),
    );
    if (hydrationErrors.length > 0) {
      facts.hydrationRecoverableErrors = hydrationErrors.length;
      facts.firstHydrationError = hydrationErrors[0];
    }
  }
  return facts;
}

export const reactAddon: Addon = {
  name: ADDON_NAME,

  pageInit(): AddonPageInit {
    // The mini-hook installs before app code (evaluateOnNewDocument) on every browser lane. Detection
    // and commit counting need no sampler and no trace, so they work in every capture mode.
    return { install: installReactHook };
  },

  enrich(context: AddonEnrichContext): string[] {
    const notes: string[] = [];
    const runSpan = context.spans.find((span) => span.kind === "run");

    // Browser lanes: attach detection + commit facts ONLY when the hook actually saw React register a
    // renderer. The hook seeds `detected:false` and a `commits:0` step channel on every page it runs
    // on, so gating on detection is what keeps a non-React app free of any React vocabulary (the addon
    // must feel absent when the framework is absent).
    const runPayload = context.pageData?.[ADDON_NAME] as ReactPageData | undefined;
    const detected = runPayload?.detected === true;
    if (runSpan && detected && runPayload) attach(runSpan, shapeDetection(runPayload));

    // Per-step commit counts (driver mode): each step's own window delta, an exact-count-tier metric.
    // Only when React was detected, so a non-React step never gets a `commitCount: 0` (a real React
    // step that committed nothing legitimately reports 0).
    if (detected)
      for (const span of context.spans) {
        if (span.kind !== "step") continue;
        const stepPayload = context.stepData.get(span.label)?.[ADDON_NAME] as
          | { commits?: unknown }
          | undefined;
        if (stepPayload && typeof stepPayload.commits === "number")
          attach(span, { commitCount: stepPayload.commits });
      }

    // Node lane: the react-dom server-phase self-time rollup, when react-dom frames resolved. Gated on
    // the node lane (not merely "no page data"), so a chrome run whose page read failed can never roll
    // a client bundle's frames up as "server phases". Absent when no anchor resolved (React 18
    // production SSR is mangled) -- and if react-dom frames ARE present but no anchor matched, say so,
    // so the reader knows package-level attribution still holds.
    if (runSpan && context.meta.workload?.lane === "node" && context.cpuModel) {
      const phases = reactServerPhaseRollup(context.cpuModel);
      if (phases) {
        attach(runSpan, { phases });
      } else {
        const hasReactDom = context.cpuModel.functions.some(
          (fn) => fn.package === "react-dom" || fn.package.startsWith("react-dom/"),
        );
        if (hasReactDom)
          notes.push(
            "React: react-dom self-time is present but no server-phase anchor resolved by name " +
              "(React 18 production SSR is mangled; anchors resolve unmangled on React 19 production). " +
              "Per-package attribution (`query cpu --by package`) stands.",
          );
      }
    }

    return notes;
  },
};
