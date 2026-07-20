---
"@jantimon/web-performance-debugger": patch
---

Fix the `--breakdown` invalidation-count note, which told readers "a 0 there means unmeasured".
Unmeasured counts render as `—`, never 0, so the note now says the counts are reported as not
measured (—), never 0, matching every other not-measured note and the `Measured` model.
