---
"@jantimon/web-performance-debugger": minor
---

`--deep --target firefox` surfaces Gecko's native cause-stack write identity as a first-class
dirtied-by report. `query blame --dirtied` lists the write each forced flush blames, labelled
`first-invalidation-only` (Gecko records only the first invalidation since the last flush, not
Chrome's full write set), so it never fabricates a forced-by read side or count parity Chrome has and
Firefox does not. The read side stays the sampled read-site blame (`query blame --forced`).
