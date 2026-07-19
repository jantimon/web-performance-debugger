---
"@jantimon/web-performance-debugger": minor
---

`diff` matches spans by `kind:label` and warns when a metric is comparable on one side only, rather
than inventing a delta: a slice or count measured on one recording but not the other reports `n/a`,
never a fabricated regression. The qualified `kind:label` join keeps a user `performance.measure`
named `run` from colliding with the run span.
