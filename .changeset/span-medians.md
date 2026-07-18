---
"@jantimon/web-performance-debugger": minor
---

`performance.measure` spans repeated under `--iterations` now merge their occurrences instead of
reporting iteration 1's bar. The stored span is the lower-median-by-wall real occurrence, so
`Σ slices + idle = wall` still holds exactly (no per-slice averaging). `query spans` / `query digest`
disclose the merge: `aggregation: "median"`, `samples` (occurrence count), and `wallMinMs`/`wallMaxMs`
(the wall spread). Chrome (`--breakdown`) and Firefox report identical semantics. Run/step spans and
single-occurrence measures are unchanged; old recordings load as before.
