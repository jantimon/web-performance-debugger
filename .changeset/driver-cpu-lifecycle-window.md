---
"@jantimon/web-performance-debugger": patch
---

Keeps driver-mode `prepare()` and warmup out of the CPU model. The V8 sampler opened before
`prepare()` ran, and the CPU model spans the whole profile, so page-side JS from setup inflated
`scriptingMs`, the package rollup, the run-span hot functions and `cpu-diff` (measured: a `run()`
doing ~5 ms beside a `prepare()` doing ~80 ms read `scriptingMs` ~88 ms with the setup loop as the top
hot function). The sampler now opens at the `wpd:run:start` mark, pricing the run only (~9 ms on that
probe), matching bench. Trace counts and `--breakdown` bars are unchanged; `cleanup()` was already
excluded.
