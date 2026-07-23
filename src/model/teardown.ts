/**
 * Fold a teardown failure into a primary error without masking it.
 *
 * When the user's flow (or the run) has already failed and a teardown step (a cleanup hook, a
 * browser close, an inspector disconnect) then also throws, the teardown failure must not replace the
 * primary error: the caller would debug teardown instead of the workload. Attach the teardown failure
 * as the primary error's `cause` (never overwriting one already set) so the primary keeps propagating
 * and the secondary is still recoverable. When `primaryError` is not an Error (or already carries a
 * cause), the teardown failure is dropped, since the primary is the one to surface.
 */
export function attachTeardownFailure(primaryError: unknown, teardownError: unknown): void {
  if (primaryError instanceof Error && primaryError.cause === undefined)
    primaryError.cause = teardownError;
}
