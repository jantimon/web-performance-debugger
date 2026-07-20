---
"@jantimon/web-performance-debugger": patch
---

New `record --keep-partial` (driver mode): when a later `--iterations` iteration fails on a flaky
production site, keep the iterations that completed instead of discarding the whole run. The salvaged
recording carries a loud note naming the failed iteration and the step it died on, and `meta.iterations`
becomes the completed count. A failure in the FIRST iteration still errors: a flow that never completed
once has nothing honest to salvage.
