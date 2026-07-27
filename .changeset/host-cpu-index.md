---
"@jantimon/web-performance-debugger": minor
---

Recordings now stamp `meta.hostCpuIndex`, a host-CPU speed scalar measured by a short
dependency-free microbenchmark in node before each capture (all lanes). `record` and `query cpu`
print it beside the numbers. `diff`/`cpu-diff --fail-on-regression` WARN, naming both values, when
two recordings' indices are more than 25% apart, since CPU self-time ms are host-relative. It is a
fact and a comparability warning only: self-time is NOT normalized, and the axis advises rather than
blocks (a host difference is environmental, so a same-machine gate is never refused).
