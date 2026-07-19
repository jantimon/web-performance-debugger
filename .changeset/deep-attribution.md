---
"@jantimon/web-performance-debugger": minor
---

`--deep` (chrome) is the attribution report: exact forced-by read-sites plus the **dirtied-by** write
that made each flush necessary, and a **layout-thrashing detector**.

The thrash detector walks each top-level task in order and counts the write→read→write→read signature
where a geometry read re-flushes a layout an intervening write just dirtied, matching invalidation
kind to flush kind. `record --deep` prints `⚠ layout thrashed Nx` with the interleave; `query blame
--forced` shows the dirtied-by write under each read; `query span run` carries the thrash rollup.
Slice durations stay suppressed on `--deep` (the `.stack` trace distorts them); run `--breakdown` for
the reconciling bar.
