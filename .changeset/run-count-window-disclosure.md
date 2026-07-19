---
"@jantimon/web-performance-debugger": patch
---

Disclose that a chrome run's rendering counts (start-onward from `run:start`, so they catch the
frame that paints just after `run:end`) and its `[run:start, run:end]` reconciling bar cover
different windows, so a run `paintCount`/`layoutCount` above its bar slice reads as the trailing
frame, not a bug. Shown as a `meta.notes` line under `--breakdown` and in `query span run`. No
numbers changed.
