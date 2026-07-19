---
"@jantimon/web-performance-debugger": minor
---

`query span <label>` now shows per-span hot functions for step and measure spans, not just the run
window. On a `--breakdown` chrome recording (step and measure spans) and a firefox recording (measure
spans), the anatomy ranks the span's own hottest JS functions from the CPU sampler, resolved to
source via the sibling CPU model.

The list lives on the CPU-sampler scripting axis, so its `self %` is each function's share of the
span's pooled JS samples (the panel discloses the pooled sample and occurrence counts); it is never
reconciled against the bar's `js` slice. A measure pools samples across all its occurrences; a span
with too few samples reports the ranking as suppressed with a raise-`--iterations` hint rather than a
noisy top-N. The `hot.scope` / `hot.pooledSamples` / `hot.occurrences` / `hot.suppressed` fields are
new in the `query span --json` output; `hot.sampleCount` is replaced by `hot.pooledSamples`, and
stored per-span hot rows carry no `totalMs` (it was run-wide, not span-local).
