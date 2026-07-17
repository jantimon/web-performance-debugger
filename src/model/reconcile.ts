/**
 * The one epsilon + residual policy shared by every reconciling breakdown (the seven-slice span
 * breakdown and the four-slice CPU breakdown). A breakdown tiles its window EXACTLY by construction,
 * so `Σ slices === wallMs` up to float dust; anything larger is a real discrepancy (a lost event, an
 * unattributed sample) and must surface rather than silently shrink a slice.
 */

/** Float dust below this (ms) is not a real residual; the tiling is exact by construction. */
export const RECONCILE_EPSILON_MS = 1e-6;

/**
 * Check that a breakdown's slices tile its window, returning the residual to record when they do
 * NOT. `undefined` means the tiling closed within the shared epsilon (the normal case). A returned
 * number is the honesty valve: the caller stores it as `residualMs` instead of rescaling a slice to
 * force the sum, so a lost event or an unattributed sample is visible rather than hidden.
 */
export function reconcileResidual(wallMs: number, sliceSumMs: number): number | undefined {
  const residual = wallMs - sliceSumMs;
  return Math.abs(residual) > RECONCILE_EPSILON_MS ? residual : undefined;
}
