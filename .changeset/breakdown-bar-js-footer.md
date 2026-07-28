---
"@jantimon/web-performance-debugger": patch
---

The `--breakdown` reconciling bar's js-slice footer now describes the tiled bar it sits under: js is
trace scripting self-time and a forced layout tiles into the style/layout slices, not the js slice
(the old footer wrongly claimed the forcing-frame fold, which is true only of the four-slice CPU bar).
The chrome record report also gains one line bridging the two js figures it shows: the sampler
headline folds the engine work JS triggered, the reconciling bar splits it out, so the two are both
right.
