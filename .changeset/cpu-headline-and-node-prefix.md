---
"@jantimon/web-performance-debugger": minor
---

**Breaking:** the CPU headline is now true JS self-time, and old recordings must be re-recorded.

- `CpuModel.scriptingMs` (and `RecordingSummary.scriptingMs`) is replaced by **`jsSelfMs`** (JS-only
  self-time, the sum the per-package/per-file rows tile, so their shares add to 100%) plus
  **`activeMs`** (the non-idle sampled total: js + gc + engine/native). The old field summed
  gc/native under a "JS self-time" label; the two are now named apart. `query cpu` reports both.
- `cpu-diff --fail-on-regression` now gates on **net JS self-time**, so a change that is entirely
  gc/native, or sampler jitter that never lands on a JS frame, no longer trips it. `cpu-diff` JSON
  renames `netScriptingMs`/`netScriptingPct` to `netJsSelfMs`/`netJsSelfPct` and the per-side
  `scriptingMs` to `jsSelfMs`.
- The schema epoch is bumped (3 -> 4): recordings and `.cpu.json` models from an older wpd are
  refused with a re-record message. Re-record to read them.
- `--target node` now windows the profile to the timed loop, so the profiler-start warmup (~9-30 ms
  that previously landed on `post (node:inspector)` as a fixed hot function) is gone: a near-no-op
  reports ~0 JS self-time and two identical runs no longer manufacture a `cpu-diff` regression.
