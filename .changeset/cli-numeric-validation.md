---
"@jantimon/web-performance-debugger": patch
---

Tighten CLI argument validation so a bad number fails at the boundary instead of silently skewing a
run or a gate:

- `--max-wall`/`--max-inp` now accept non-negative fractional ms (matching stored fractional walls
  and `--max-slice`); INP budgets take floats too, for one consistent timing-budget policy.
- Count maxima (`--max-layouts`, `--max-forced`, ...) reject negatives, which could only ever fail.
- `--top` requires a positive integer; `query get`/`query frame` parse ids strictly (`abc`/`12junk`
  now error instead of becoming NaN or 12).
- `--protocol-timeout` requires a positive integer; `--cpu-throttle` requires an integer greater
  than 1, and is rejected on firefox/node whatever the value.
- `--target node` rejects `--no-headless`/`--keep-partial`/`--protocol-timeout`; `--bench` rejects
  `--keep-partial`. These lanes consume none of them.
