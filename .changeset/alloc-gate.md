---
"@jantimon/web-performance-debugger": minor
---

Add the allocation gate. A GC-pressure regression that allocates hard but costs little CPU passed every
gate before; now `alloc-diff <baseline> <current> --fail-on-regression` gates on net allocated bytes
(mirroring `cpu-diff`), and `assert --max-alloc-mb <mb>` gates the total against a budget. Both read an
`--target node --alloc` recording; a recording with no allocation model is a loud n/a-FAIL, never a
silent pass, and an alloc-diff refuses across an incompatible workload/lane/capture.

The gate floor scales with the workload, the same as `cpu-diff`: `max(--noise-floor MB, --noise-pct% of
the baseline)`, default `max(1 MB, 25%)`, since sampled byte totals are ~15-20% directional. New view
`AllocDiffResult`.
