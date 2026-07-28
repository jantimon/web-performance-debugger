---
"@jantimon/web-performance-debugger": patch
---

`cpu-diff --fail-on-regression` no longer fires the JS-self gate when BOTH recordings' `jsSelfMs` sit
below the sampler's resolving floor (~10 samples, ~2ms at the 200us interval, derived from each side's
recorded interval so the larger wins). Below resolving power a net delta is sampler quantization, not a
code change, so two identical near-zero runs now gate green; the output (human and JSON) carries a
disclosure note and the exit stays 0 unless another gated axis fires.
