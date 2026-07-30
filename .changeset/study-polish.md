---
"@jantimon/web-performance-debugger": minor
---

Three polish fixes: README links to non-shipped repo files (AGENTS.md, docs/, ...) are now absolute
GitHub URLs, so they resolve on the npm page and in an installed package. The blame docs now state
that a sampled `--breakdown` forced-blame `count` is a sampling-frequency signal, never comparable to
`--deep`'s exact flush count. The built-in `--url` load flow stamps a `meta.notes` entry (and tags the
`query span` run line) when the boot did near-zero work, the tell of a consent/region shell measured
in place of the app; note-tier only, never a gate.
