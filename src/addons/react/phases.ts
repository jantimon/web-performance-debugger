// Node-lane server-phase rollup: attribute react-dom's server-render self-time onto a MINIMAL
// allowlist of stable phase-anchor names. Pure over the resolved CpuModel, so it is unit-testable
// against a synthetic profile with no browser.
//
// [probe] React 19 production SSR ships its server build UNMANGLED (181 named functions), so these
// anchors resolve in production on 19 with no dev build and no sourcemaps. React 18 production SSR is
// mangled (one-letter names), so the anchors do NOT resolve and the rollup is empty -> the fact is
// absent, honestly. The allowlist is deliberately TINY and per-major fragile: 2 of 10 CLIENT work-loop
// anchors renamed 18->19, so any name-based recovery must be re-verified against each React major, not
// trusted as a stable map. See docs/dev/react-attribution.md#the-anchor-allowlist-is-fragile-across-majors.

import type { CpuFunction, CpuModel } from "../../model/recording.js";
import type { ReactPhaseRollup } from "./facts.js";

/**
 * The minimal, per-major-verified server-phase anchors. Kept short on purpose: an exhaustive map rots
 * silently on a major bump (see the fragility note above). These are react-dom SERVER render/emit
 * functions [source: react-dom server source], stable 18->19 and present unmangled in 19 production.
 */
const SERVER_PHASE_ANCHORS: ReadonlySet<string> = new Set([
  "renderNode",
  "renderElement",
  "renderWithHooks",
  "pushStartInstance",
  "flushCompletedQueues",
  "flushSegment",
  "flushSubtree",
]);

/** Whether a resolved frame belongs to react-dom (by owning package, else the file path as a fallback
 * for an off-disk/served build). */
function isReactDomFrame(fn: CpuFunction): boolean {
  if (fn.package === "react-dom" || fn.package.startsWith("react-dom/")) return true;
  return fn.file != null && fn.file.includes("react-dom");
}

/**
 * Roll react-dom self-time onto the server-phase anchors. Returns undefined when NO anchor resolved a
 * frame (React 18 production's mangled server build, or a workload that ran no SSR), so the caller
 * leaves the `phases` fact absent rather than emitting an empty rollup. The per-anchor sum pools every
 * frame that resolved to that anchor name inside react-dom.
 */
export function reactServerPhaseRollup(model: CpuModel): ReactPhaseRollup | undefined {
  const selfMsByAnchor = new Map<string, number>();
  for (const fn of model.functions) {
    if (!SERVER_PHASE_ANCHORS.has(fn.fn)) continue;
    if (!isReactDomFrame(fn)) continue;
    selfMsByAnchor.set(fn.fn, (selfMsByAnchor.get(fn.fn) ?? 0) + fn.selfMs);
  }
  if (selfMsByAnchor.size === 0) return undefined;
  const anchors = [...selfMsByAnchor.entries()]
    .map(([name, selfMs]) => ({ name, selfMs }))
    .sort((left, right) => right.selfMs - left.selfMs);
  const totalMs = anchors.reduce((sum, anchor) => sum + anchor.selfMs, 0);
  return { totalMs, anchors };
}
