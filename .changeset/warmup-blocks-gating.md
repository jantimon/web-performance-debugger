---
"@jantimon/web-performance-debugger": minor
---

**`--warmup` now blocks a regression gate.** A `--warmup` difference between two recordings carries
workload state (cache priming, JIT tiers, lazy CSS, memoization, first-render code): moving a call
across the warmup boundary changes which counts and self-time land in the timed window, so a
first-call layout can read as `0 -> 1` from config alone. `diff --fail-on-regression` and
`cpu-diff --fail-on-regression` now REFUSE to gate across mismatched `--warmup` (they used to warn
and gate anyway), naming the mismatch. Re-record both sides with the same `--warmup` to gate.
