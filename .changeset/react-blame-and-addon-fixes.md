---
"@jantimon/web-performance-debugger": patch
---

Three React-debugging fixes:

- `query blame --forced` on `--breakdown` now resolves a forcing read to source. A sampled read-site
  whose executing line falls on a minified bundle line falls back to the leaf function's own column
  (the frame the CPU model resolves), so a bundled app shows `app.jsx:8`, not `dist/app.js:9`.
- `query span <step>` no longer prints "React (addon): not detected" on a step span. Detection is a
  run-level fact; a step shows its commit count alone. JSON stays honest (detection absent, not fake).
- The `react-dev` Performance-Track summary now reports real per-track ms, read from each entry's
  `start`/`end` (the instant TimeStamp events carry the span there, not on `dur`). Tracks nest, so the
  timing is per-track, no grand total.
