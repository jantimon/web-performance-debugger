---
"@jantimon/web-performance-debugger": patch
---

`query spans` overview now carries the exact rendering counts a recording measured, on every row
including the bar-bearing ones (chrome `--breakdown`, firefox measure). `null` keeps meaning
not-measured, never not-projected, so the overview no longer reads as "not-measured" for a count the
drill (`query span`) shows measured.
