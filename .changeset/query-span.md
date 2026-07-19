---
"@jantimon/web-performance-debugger": minor
---

New `query span <file> <label>` drills into one span's full anatomy: its reconciling bar, wall and
aggregation with the sample spread, the Measured counts, INP and its CWV split, the forced read-sites
with their dirtied-by writes and the thrash rollup (on an event-log rung), and the run-window hot
functions. `<label>` is a bare label or a `kind:label` qualifier (`run:`, `step:`, `measure:`), so a
label that collides across kinds is resolved rather than silently joined.
