---
"@jantimon/web-performance-debugger": minor
---

**New: `record --breakdown` (chrome), a reconciling seven-slice bar per span.** One fused pass (a
light trace + the CPU sampler) produces `js (by package) · style · layout · paint · gc · other ·
idle` for the run window, each driver step, and every user `performance.measure` inside the run.
Each bar tiles its window exactly (`Σ slices + idle = wall`); slices come from the trace, and the
`js` split from the samples that land in its regions (proportions only). Stored additively as
`Recording.breakdowns` and shown in the `record` report and `query digest`; old recordings keep
loading. Forced-layout count and blame need the `.stack` category this mode drops, so they are
reported as **not measured** (never 0) -- run the default mode for forced-layout blame.

**New: `record --headless-mode new|shell` (chrome).** `shell` launches chrome-headless-shell, which
runs frames at ~120Hz and halves the one-frame floor on `wall`/`INP` (16.6 -> 8.3ms). `shell` is the
default; pass `--headless-mode new` to run the full-Chrome new headless (~60Hz) instead.
