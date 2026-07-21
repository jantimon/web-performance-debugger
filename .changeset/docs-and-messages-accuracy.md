---
"@jantimon/web-performance-debugger": patch
---

Correct the pnpm install recipe (pnpm 11 dropped the `package.json` field and needs `allowBuilds` in
`pnpm-workspace.yaml`), make the SSR and assert quickstart blocks self-contained from a clean
checkout, and fix a reversed `query span` example. Help and notes now state the sampler's real cost
(~4-7% on mixed work, ~1% on JS-heavy) and that `--user-data-dir` holds sensitive state and works on
firefox; a schema mismatch on a newer artifact now says "upgrade wpd" rather than "re-record".
