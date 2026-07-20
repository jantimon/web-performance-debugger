---
"@jantimon/web-performance-debugger": minor
---

`--breakdown` now sources CPU samples from the trace's `v8.cpu_profiler` stream instead of the CDP
sampler. The trace stream is continuous across a cross-document navigation, so a navigating driver
step (or an early measure occurrence) now keeps its per-step CPU attribution -- the js-by-package
split and hot-function list -- where the CDP sampler dropped it (it resets in the new renderer
process). No CDP profiler runs on this rung.

The sampler interval on `--breakdown` is now the stream's own fixed rate (~150us), read back from the
chunks and recorded in `meta.cpuIntervalUs`/the CPU model, rather than the 200us default. Other rungs
(default, `--deep`, `--precise-wall`, firefox, node) are unchanged. When a browser build emits no
chunk stream, the run reports the counts and an honest note rather than fabricating samples.
