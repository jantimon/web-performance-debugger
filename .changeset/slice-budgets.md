---
"@jantimon/web-performance-debugger": minor
---

`assert` gains per-slice budgets and `diff` gains per-span slice deltas.

`assert --max-slice <name>=<ms>` (repeatable, e.g. `--max-slice js=5 --max-slice layout=2`) gates a
span's breakdown slice ms; `--label <label>` picks a span other than the run span. A budget on a
slice or label the recording did not measure is a loud FAIL, never a silent pass. Slice ms is
directional, never count-exact: trace wall-tier (~1%) on `--breakdown` bars, the profiler's own
clock on CPU-only bars.

`diff` now prints per-span slice ms deltas, matched by span label, for recordings that carry a
breakdown. These are advisory (directional ms) and never fail the gate; count deltas still gate as before.
Valid slices: js, style, layout, paint, gc, other, idle.
