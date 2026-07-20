---
"@jantimon/web-performance-debugger": patch
---

Fix `record --url <heavy page> --breakdown` crashing with `Maximum call stack size exceeded` while
merging the CPU-sample streams a navigation splits. A failed `record` now always exits non-zero so CI
and scripts can detect it, and `WPD_DEBUG=1` prints the error stack.
