---
"@jantimon/web-performance-debugger": minor
---

The `react` addon now names a hydration mismatch, not just its cost. React's default
`onRecoverableError` dispatches a window `error` event; a mismatch fires one. The pre-app hook counts
the hydration recoverable errors and stamps `hydrationRecoverableErrors` + the first message on the
run span, shown in the `React (addon)` block of `query span run` and in `--format json`. Exact-count
tier, build-independent (production fires it). An app that supplies its own `onRecoverableError`
suppresses the event, so an absent count is not proof of clean hydration.
