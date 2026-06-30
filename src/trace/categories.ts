export const INVALIDATION_TRACKING_CATEGORY =
  "disabled-by-default-devtools.timeline.invalidationTracking";

/** DevTools timeline categories that surface layout, paint, and invalidation events. */
export const TRACE_CATEGORIES: string[] = [
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  // JS call stacks on timeline events (Layout/RecalcStyles) -> forced-reflow attribution
  "disabled-by-default-devtools.timeline.stack",
  INVALIDATION_TRACKING_CATEGORY,
  "blink.user_timing",
  "v8.execute",
  "loading",
];

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
