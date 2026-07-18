---
"@jantimon/web-performance-debugger": minor
---

**New: `--target firefox` gains the reconciling CPU-time breakdown bar.** The Gecko profiler now
runs with `js,cpu`, so the per-sample CPU-usage signal drives an honest `idle` slice: the `record`
report and `query cpu` show a `js · style · layout · browser · gc · idle` bar that tiles the sampled
window exactly (style/layout from the sampled Layout-category frames). Paint stays a side track, not
summed. A Gecko dump without the CPU signal (older recordings) still gets no bar rather than a
fabricated idle.

**New: `performance.measure` spans on Firefox.** Each user measure inside the run window appears in
`recording.breakdowns` (kind `measure`) with its own reconciling breakdown.

**Changed: `query blame --forced` on Firefox now names the READ site + the DOM property** (e.g.
`offsetWidth`), sampled from the stacks, matching Chrome's flush-site semantics — the two engines'
forced lines are now comparable at line granularity. `meta.blameSemantic` is `flush-site` on
Firefox; the write/invalidation cause stays reachable via `query get`. Forced-layout counts still
come from the Reflow/Styles markers. Requires nothing from users.
