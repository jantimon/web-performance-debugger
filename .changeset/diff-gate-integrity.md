---
"@jantimon/web-performance-debugger": minor
---

`diff` and `cpu-diff` now refuse to gate across captures that are not comparable, instead of emitting
fabricated regressions. The `diff --fail-on-regression` comparability signature gains workload (the
recorded module/page), headless flavour, and cpu-throttle as blocking axes, and iterations now blocks
too (run counts total across iterations, so 1 vs 5 makes every count differ); warmup and sampler
interval warn. `cpu-diff` gains a comparability check of its own: it warns on any capture-axis
difference and refuses `--fail-on-regression` across a browser/runtime/workload mismatch. Two new
`meta` fields (`headlessMode`, `cpuIntervalUs`) record the axes needed for the check.
