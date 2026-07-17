export const INVALIDATION_TRACKING_CATEGORY =
  "disabled-by-default-devtools.timeline.invalidationTracking";

/** JS call stacks on timeline events (Layout/RecalcStyles): forced-reflow attribution + blame. */
export const STACK_CATEGORY = "disabled-by-default-devtools.timeline.stack";

/** DevTools timeline categories that surface layout, paint, and invalidation events. */
export const TRACE_CATEGORIES: string[] = [
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  STACK_CATEGORY,
  INVALIDATION_TRACKING_CATEGORY,
  "blink.user_timing",
  "v8.execute",
  "loading",
];

/**
 * The light category set for the fused --breakdown pass: the shipped list MINUS the `.stack`
 * category (whose stack walk on every Layout inflates sampled self-time +21% [measured], the whole
 * reason the sampler cannot ride the default trace pass) and MINUS invalidationTracking (heaviest
 * category, and the breakdown does not use invalidation events). `MinorGC`/`MajorGC` stay -- they
 * come from `devtools.timeline`, which is kept, so no gc-specific category is needed. Dropping
 * `.stack` is why this mode cannot report forced-layout counts or blame.
 */
export function breakdownTraceCategories(): string[] {
  return TRACE_CATEGORIES.filter(
    (category) => category !== STACK_CATEGORY && category !== INVALIDATION_TRACKING_CATEGORY,
  );
}

/** Trace categories, optionally without invalidationTracking. That category is by
 * far the heaviest; on invalidation-heavy interactions it can balloon the traced
 * cost super-linearly to the point of pinning the main thread. Dropping it keeps
 * paint counts and forced-reflow (stack-based) attribution; it loses only the
 * invalidation rollup (layout/style invalidation counts). */
export function traceCategories(options?: { invalidationTracking?: boolean }): string[] {
  if (options?.invalidationTracking === false) {
    return TRACE_CATEGORIES.filter((category) => category !== INVALIDATION_TRACKING_CATEGORY);
  }
  return TRACE_CATEGORIES;
}
