import type { EngineSoftNav, NavigationKind } from "./recording.js";

/**
 * How the two independent navigation verdicts for a step relate:
 *
 *  - "agree": Chrome's soft-navigation heuristic fired AND the url+timeOrigin classifier read the step
 *    soft (soft/soft-hash). The engine confirms the classifier.
 *  - "classifier-only": the classifier read the step soft but the engine fired no entry -- the
 *    probe-verified false-negative class (a programmatic history change, an untrusted synthetic click,
 *    or a route with no qualifying paint), which the engine is blind to by design.
 *  - "engine-only": the engine fired but the classifier read the step none/hard -- unexpected; both
 *    are recorded.
 *  - "none": neither read a soft navigation, so there is nothing to reconcile.
 */
export type SoftNavAgreement = "agree" | "classifier-only" | "engine-only" | "none";

export interface SoftNavVerdict {
  agreement: SoftNavAgreement;
  /** a compact, non-alarmist line stating both verdicts; absent for "none" (nothing to disclose) */
  note?: string;
}

/**
 * Reconcile the two independent navigation verdicts for a step: the always-available url+timeOrigin
 * `navigation` classifier and Chrome's OWN `soft-navigation` heuristic (`engineSoftNav`, opportunistic,
 * absent where the browser has no support or fired no entry). Pure, so the rule is unit-testable
 * without a browser.
 *
 * The two ask different questions -- one diffs the URL and the document clock, the other watches for a
 * trusted interaction that drove a same-document route to a contentful paint -- so a split is not an
 * error but two facts about two definitions. wpd states both and picks no winner. See
 * docs/dev/navigation-and-lcp.md.
 */
export function classifySoftNavAgreement(
  navigation: NavigationKind | undefined,
  engineSoftNav: EngineSoftNav | undefined,
): SoftNavVerdict {
  const engineFired = !!engineSoftNav && engineSoftNav.count > 0;
  const classifierSoft = navigation === "soft" || navigation === "soft-hash";
  const types = engineSoftNav?.navigationTypes.length
    ? engineSoftNav.navigationTypes.join("/")
    : "soft nav";
  if (engineFired && classifierSoft)
    return { agreement: "agree", note: `Chrome's soft-navigation heuristic agrees (${types}).` };
  if (!engineFired && classifierSoft)
    return {
      agreement: "classifier-only",
      note:
        `url+timeOrigin classifies this step "${navigation}", but Chrome's soft-navigation heuristic ` +
        `fired no entry. The heuristic needs a trusted interaction, a same-document history change, ` +
        `and a contentful paint, so a programmatic history change or an untrusted synthetic click is ` +
        `invisible to it by design. Two definitions of a navigation, both facts.`,
    };
  if (engineFired && !classifierSoft)
    return {
      agreement: "engine-only",
      note:
        `Chrome's soft-navigation heuristic fired (${types}), but url+timeOrigin classifies this step ` +
        `"${navigation ?? "none"}". Both are recorded.`,
    };
  return { agreement: "none" };
}
