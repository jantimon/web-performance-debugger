---
"@jantimon/web-performance-debugger": minor
---

Chrome `--breakdown` recordings now answer `query blame --forced` with sampled read-site
forced-layout blame, instead of refusing.

The light `--breakdown` trace has no `.stack`, but the fused `v8.cpu_profiler` stream keeps sampling
through a synchronous forced layout and carries a per-sample executing line (`data.lines`). Joining
each layout/style flush window against those samples recovers the forcing read line — the same
flush-site semantic as `--deep` and firefox, and comparable at line granularity. It is a sampled
estimate: a flush narrower than one sampler interval is marked `~low-confidence` (it can lag one
statement). The exact forced COUNT still needs `--deep`; a sampled event never inflates a count or an
`assert --max-forced` gate. In a run group, `query blame --forced` prefers a `--deep` member (exact)
and falls back to a `--breakdown` member (sampled).
