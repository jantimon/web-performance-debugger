---
"@jantimon/web-performance-debugger": minor
---

**Breaking:** `record --precise-wall` is removed.

The CPU sampler now rides every chrome sampling capture. Its wall cost (~4-7% on mixed work, ~1% on
JS-heavy work) is systematic, so it cancels in `diff`/`cpu-diff` — both sides carry it. A sampler-free
wall only serves absolute-wall benchmarking, which wpd does not measure: the wall is directional and
the attribution (line, package, count) is the product.

Migration: record in the default capture mode and compare runs with `diff`. An explicit
`--precise-wall` now exits with a message naming the change. Recordings written by the old mode still
open and report their metrics not-measured.
