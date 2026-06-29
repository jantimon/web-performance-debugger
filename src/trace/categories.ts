/** DevTools timeline categories that surface layout, paint, and invalidation events. */
export const TRACE_CATEGORIES: string[] = [
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  // JS call stacks on timeline events (Layout/RecalcStyles) -> forced-reflow attribution
  "disabled-by-default-devtools.timeline.stack",
  "disabled-by-default-devtools.timeline.invalidationTracking",
  "blink.user_timing",
  "v8.execute",
  "loading",
];
