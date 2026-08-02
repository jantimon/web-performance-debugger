---
"@jantimon/web-performance-debugger": minor
---

`cpu-diff --fail-on-regression`: the noise floor now scales with the workload. The net JS self-time
must clear `max(--noise-floor ms, --noise-pct% of the baseline)`, default `max(0.5 ms, 15%)`. The old
fixed 0.5 ms floor false-reds byte-identical code more as the workload grows (measured ~2% at a 5 ms
workload, ~40% at 220 ms / `--iterations 20`), because summed self-time grows while the floor stays
absolute; the percentage term tracks it, so identical code stays green at any iteration count while a
30%+ regression on a small workload still fails.

New flags `--noise-floor <ms>` and `--noise-pct <n>` widen (or tighten) the two terms; `CpuDiffResult`
JSON now carries `noisePct` and the effective `gateFloorMs`.
