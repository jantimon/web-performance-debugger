import { InvalidArgumentError } from "commander";

/**
 * The CLI's one numeric-validation policy: four parsers for the whole-number and ms-threshold flags,
 * each throwing an `InvalidArgumentError` commander renders at the argument boundary before any
 * browser launches. Kept off `cli.ts` so they are pure functions a unit test calls directly, not a
 * subprocess it spawns to read stderr wording.
 */

/**
 * Rejects what parseInt would quietly accept. Bare `parseInt` turns `abc` into NaN and `1.5` into
 * 1, and every option below would then carry that forward silently: NaN passes every range check
 * (every comparison with NaN is false), so `--iterations abc` would reach a `for (i = 0; i < NaN)`
 * loop that never runs and record 0 layouts -- zeros indistinguishable from a clean page. Fail on
 * the argument instead, once, for every option that parses a whole number.
 */
export const toInt = (value: string) => {
  if (!/^-?\d+$/.test(value.trim()))
    throw new InvalidArgumentError(`'${value}' is not a whole number.`);
  return parseInt(value, 10);
};

/**
 * A non-negative ms threshold (fractional allowed): a wall/INP budget is a wall-tier ms, not a
 * count, and stored walls are fractional, so a whole-number-only parser rejects a legitimate
 * `--max-wall 40.5`. The regex rejects negatives, exponents, Infinity and NaN, so the result is a
 * finite bound.
 */
export const toFloat = (value: string) => {
  if (!/^\d+(\.\d+)?$/.test(value.trim()))
    throw new InvalidArgumentError(`'${value}' is not a non-negative number.`);
  return parseFloat(value);
};

/**
 * A count/time maximum below zero can never be met, so a gate set that way fails forever and points
 * the reader at the data instead of the typo. Reject it at the boundary.
 */
export const toNonNegativeInt = (value: string) => {
  const parsed = toInt(value);
  if (parsed < 0) throw new InvalidArgumentError(`'${value}' must be zero or greater.`);
  return parsed;
};

/**
 * A positive whole count: `--top` feeds `.slice(0, n)`, so zero or a negative slices from the end
 * and prints nonsense like "below the top -1". Require at least one.
 */
export const toPositiveInt = (value: string) => {
  const parsed = toInt(value);
  if (parsed < 1) throw new InvalidArgumentError(`'${value}' must be a positive whole number.`);
  return parsed;
};
