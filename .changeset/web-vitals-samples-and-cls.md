---
"@jantimon/web-performance-debugger": minor
---

Boot LCP is now per-iteration sampled: under `--iterations N` the `load` step's `lcp` grows
`perIteration` (the render-time series, `null` for an iteration that fired no entry, never 0) and
`stats` (min/median/max), the same shape `wall` carries, so a run-to-run LCP swing is visible instead
of hidden behind one number. `query span` prints the spread; the identity fields stay a real sample.

Add per-step CLS: a driver step carries `layoutShift` (Chrome only) — the spec session-window maximum
(session windows gap-capped at 1s / window-capped at 5s, `hadRecentInput` shifts excluded), not a raw
sum, with the top shifting elements attributed (`tag#id`, rect deltas). Scoped to the step's own
window; Firefox has no `layout-shift` entry type, so it is absent there, never a fake 0. Both are
additive fields (schema stays 4).
