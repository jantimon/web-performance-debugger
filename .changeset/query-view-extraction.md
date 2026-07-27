---
"@jantimon/web-performance-debugger": patch
---

Retire the dead `invalidation-site` blame semantic and its two reader branches. No recording this
build reads can carry it (production stopped emitting it before the schema-4 bump, and `model/artifact`
rejects any other schema), so the value is unreachable.

`BlameSemantic` (exported from `index.ts`) narrows from `"flush-site" | "invalidation-site"` to
`"flush-site"`. A consumer matching the removed member no longer type-checks.

No CLI output or behavior changes: terminal printing for `query span`/`query spans` moved to
`commands/query-view.ts`, byte-identical.
