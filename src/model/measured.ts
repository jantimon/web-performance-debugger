/**
 * A value that is either measured on this run or explicitly not measured. The whole tri-state
 * contract every count/timing carrying it must honor lives here, so no consumer has to re-derive it:
 *
 *   - a number, 0 included: MEASURED. 0 means measured clean (e.g. no forced layout), NOT absence.
 *   - null: NOT measured on this run -- the mode could not observe it (e.g. --breakdown drops the
 *     `.stack` trace category that forced-layout detection needs). A CI gate like `assert
 *     --max-forced` treats null as a LOUD failure, never a silent pass: a gate you asked for but
 *     cannot evaluate has not passed. A `diff` refuses to compare it rather than invent a 0 -> 45
 *     regression.
 *   - absent (undefined / the field missing entirely): the field PREDATES the reader -- an older
 *     artifact written before it existed. Readers default it at the read site (`?? 0`, `?? "—"`).
 */
export type Measured<T> = T | null;

/**
 * Producer helper: the measured `value` when `condition` held, else null (not measured). One call in
 * place of a `condition ? value : null` ternary, so a producer states the tri-state the same way
 * everywhere.
 */
export function measuredIf<T>(condition: boolean, value: T): Measured<T> {
  return condition ? value : null;
}

/** The outcome of gating a Measured number against a threshold: not-measured is its own state, kept
 * distinct from ok/fail so a caller can word the "cannot evaluate" failure differently. */
export type MeasuredGate = { measured: false } | { measured: true; value: number; ok: boolean };

/**
 * Assert-side helper: gate a Measured value against a max the way a CI gate must. A null (not
 * measured) is `{ measured: false }`, which the caller renders as a loud FAIL -- never a silent pass,
 * because "could not be evaluated" is not "within the threshold". A measured value carries its
 * narrowed number back so the caller can print and compare it.
 */
export function gateMeasured(value: Measured<number>, max: number): MeasuredGate {
  if (value == null) return { measured: false };
  return { measured: true, value, ok: value <= max };
}

/**
 * View helper: render a Measured value for a table or report. Measured => `format(value)`; not
 * measured => `notMeasured`, the placeholder the caller chooses (default the em-dash a table uses
 * for a missing cell, or a fuller "not measured (...)" sentence for a headline).
 */
export function formatMeasured<T>(
  value: Measured<T>,
  format: (value: T) => string,
  notMeasured = "—",
): string {
  return value == null ? notMeasured : format(value);
}
