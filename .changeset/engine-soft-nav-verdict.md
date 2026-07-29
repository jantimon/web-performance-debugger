---
"@jantimon/web-performance-debugger": minor
---

Record Chrome's own soft-navigation verdict on a driver step, beside the url+timeOrigin classifier. On
a Chrome that ships the Soft Navigations API (151+, default-on) a step carries `engineSoftNav`
(`count`, `navigationTypes`, and the numeric ids) from an in-page `soft-navigation` observer. It is
opportunistic: wpd never forces `--enable-features`, so an older Chrome or Firefox records nothing, and
absence is never a fabricated 0.

`query span` reconciles the two verdicts: where the classifier reads a step "soft" but the engine fired
no entry (a programmatic history change, an untrusted click, or no qualifying paint), it notes both and
picks no winner, so a route the engine's metrics miss is visible rather than hidden.
