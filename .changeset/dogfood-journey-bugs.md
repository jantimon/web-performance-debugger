---
"@jantimon/web-performance-debugger": patch
---

Three fixes for driver flows that navigate cross-process.

- **`--breakdown` no longer reports all-zero bars when a step touches the page before navigating.** A
  stray flush on the pre-navigation renderer used to defeat the cross-process re-anchor, tiling the
  whole run on the blank host thread and reporting the loaded page as ~100% idle. It now re-anchors on
  the marker thread's rendering SHARE, so the counts and bar follow the page to its new process.
  Successive cross-process navigations, which no single thread can hold, now emit a loud WARNING
  instead of a silent zero bar for the un-tiled process.
- **`waitForStable` survives a hard cross-document navigation mid-wait** (a `location` swap, meta
  refresh, or redirect the step lands on): it re-attaches to the new document instead of failing the
  whole record with "Execution context was destroyed".
- **`query spans` renders a --deep recording** (label/kind/wall/aggregation/counts, bars not-measured)
  instead of erroring, so the overview-then-drill flow works on the capture with the richest counts.
