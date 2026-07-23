---
"@jantimon/web-performance-debugger": minor
---

Driver mode now hands `run`/`prepare`/`cleanup` the `waitForStable` helper in their argument
(`run({ page, measureStep, waitForStable })`), so a driver module needs no package import and works
under bare `npx`. The exported `waitForStable` still works for installed modules. TypeScript users can
annotate the hook with the new `DriverContext` export.

`waitForStable` gains a `timeoutMs` cap (default 30000; `timeout` kept as an alias). When the DOM never
goes quiet within it — a countdown, a poll, injected content — it now fails loudly naming both
`quietMs` and `timeoutMs`, instead of silently pricing the whole cap as a settled wall.

A `--url` boot that fails with `net::ERR_HTTP2_PROTOCOL_ERROR` under the default chrome-headless-shell
now re-throws guidance to retry with `--headless-mode new`, whose network stack differs.
