---
"@jantimon/web-performance-debugger": minor
---

Report sourcemap resolution instead of failing silently; stop blaming unmapped code on `app`

Per-package CPU attribution depends on a bundle's sourcemap. Every failure to fetch one was
swallowed by a bare `catch`, so `query cpu --by package` reported a single bundle-shaped `app`
bucket of minified frame names with no indication anything had gone wrong. It reads as "wpd cannot
attribute a minified bundle" when the real cause is a map wpd could not reach.

- **`meta.sourcemaps`** (new, optional) records every script a map was attempted for, how many
  resolved, and the failing urls grouped by reason: `no-sourcemap-url`, `script-fetch-failed`,
  `map-fetch-failed`, `map-parse-failed`. The record report prints a `Sourcemaps: 0/1 resolved` line
  under the package table, and `meta.notes` carries a `WARNING` when nothing resolved.
- **`SourceMap` / `X-SourceMap` response headers** are now honoured, not just the trailing
  `sourceMappingURL` comment. Production builds commonly strip the comment and keep the header, in
  which case attribution previously failed with no explanation.
- **BREAKING — unmapped remote frames bucket by origin**, e.g. `(cdn.example.com)`, instead of
  `"app"`. Third-party scripts without maps (analytics, chat widgets) were being blamed on your own
  bundle. `"app"` now means what it says: a resolved source outside `node_modules`.

  This changes `package` values, so **`cpu-diff --by package` across recordings made before and
  after this release** will show a phantom `app` drop against a new `(host)` bucket. Diffs between
  two recordings from the same version are unaffected, as are `functionJoinKey` (joins on `file`)
  and `assert` (never reads `package`).

  Note a run whose own bundle ships no usable map now reports its code under `(localhost:5173)`
  rather than `app`. That is the honest answer — the owner is genuinely unknown — and
  `meta.sourcemaps` says why.
- **One `SourceMapResolver` per run**, shared by both stack-resolution passes and the CPU model
  build. Each previously built its own, re-fetching the same remote script and map up to 3x per run.
