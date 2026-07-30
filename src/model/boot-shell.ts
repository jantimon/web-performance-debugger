/**
 * Whether the built-in `--url` load flow booted but did almost no work: the signature of a
 * consent/region interstitial or an app shell measured in place of the app it gates. Note-tier only
 * (record.ts stamps `meta.notes`, query-view tags the run line); NEVER a gate and NEVER a refusal.
 *
 * Conservative by design. It fires only on a COUNTING capture (chrome `--breakdown`, firefox), where
 * BOTH the JS self-time AND the layout/style counts are honestly measured: a default-mode boot leaves
 * the counts not-measured (null), and treating not-measured as near-zero would break the Measured
 * null-vs-0 rule (model/measured.ts). `--deep` measures counts but not JS self-time (sampler off), so
 * it too fails the gate below. Every threshold is per-iteration; the note wording ("if this site
 * normally renders an app") stays honest even when a genuinely tiny static page trips it.
 */

import type { Measured } from "./measured.js";

// [measured] field shell case: ~3ms JS self-time per iteration on a 316ms-wall boot with an <li> LCP
// element. A real SPA boot (react-counter) spends ~14ms of its own scripting per iteration. 5ms sits
// between the two, so a real app's boot clears the floor and a shell's near-zero JS trips it.
const SHELL_JS_SELF_MS_PER_ITER = 5;
// [measured] field shell case: single-digit layout/style/paint operations (it relaid out only its own
// consent panel). A real app boot commits dozens to hundreds (the forced-layout probe alone lays out
// 500). 20 per iteration sits well above a shell's handful and well below a real app's boot.
const SHELL_RENDER_COUNT_PER_ITER = 20;

export function looksLikePreAppShell(input: {
  isBuiltinLoad: boolean;
  jsSelfMs: Measured<number>;
  layoutCount: Measured<number>;
  styleCount: Measured<number>;
  paintCount: Measured<number>;
  iterations: number;
}): boolean {
  const { isBuiltinLoad, jsSelfMs, layoutCount, styleCount, paintCount, iterations } = input;
  if (!isBuiltinLoad || iterations < 1) return false;
  // Counting capture only: layout AND style must be measured (chrome `--breakdown`, firefox). Default
  // mode leaves them null; `--deep` measures counts but leaves jsSelfMs null, so it fails here too.
  if (jsSelfMs == null || layoutCount == null || styleCount == null) return false;
  if (jsSelfMs / iterations > SHELL_JS_SELF_MS_PER_ITER) return false;
  // Paint is off-main-thread on firefox (not-measured), so sum only the counts that were observed.
  const renderCount = layoutCount + styleCount + (paintCount ?? 0);
  return renderCount / iterations <= SHELL_RENDER_COUNT_PER_ITER;
}
