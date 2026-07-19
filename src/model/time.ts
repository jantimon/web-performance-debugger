/**
 * Unit conversions between the clocks the tool measures in, defined once so a bare `* 1000` or
 * `/ 1000` never has to be read for its direction. Trace and CPU-profile timestamps/durations are
 * microseconds; everything a human reads is milliseconds.
 *
 * When more than one clock is in scope, name the timestamp for its clock (traceTs, pageNowMs,
 * profileTs) so a conversion's source is unambiguous at the call site.
 */

/** Microseconds per millisecond: the factor between the trace/CPU microsecond clock and ms. */
export const US_PER_MS = 1000;

/** Microseconds -> milliseconds (trace/CPU durations to a human-readable ms). */
export const usToMs = (microseconds: number): number => microseconds / US_PER_MS;

/** Milliseconds -> microseconds (a ms interval onto the trace/CPU microsecond clock). */
export const msToUs = (milliseconds: number): number => milliseconds * US_PER_MS;
