---
"@jantimon/web-performance-debugger": patch
---

Correction: Firefox **does** measure INP; the note saying otherwise was wrong

0.3.0 told users that on `--browser firefox` "INP is NOT measured", listing it alongside the
genuinely CDP-dependent metrics. That was false. INP has never come from CDP: it is an in-page Event
Timing `PerformanceObserver` installed by the driver, ungated by browser capabilities, and Firefox
152 supports it (`event` and `first-input` are in `supportedEntryTypes`). Firefox driver runs have
been reporting real per-step INP all along, while wpd's own output denied it.

No behavior changed — only the claim. If you skipped Firefox INP because of that note, it works.

**The honest caveat, measured rather than assumed** (Firefox 152 / Chrome 150, one 100 ms click
handler on an identical page): chrome reports `duration` 160 ms (processing 112.2 + presentation
47.4), firefox 128 ms (processing 111.0 + presentation 16.0). Both span the interaction **through
the next paint** and round to 8 ms, so Firefox is not a truncated processing-only number. But
presentation delay is genuinely engine-specific, so Firefox reads systematically lower for identical
work. Compare a browser against itself across a change; do not put the two engines in one column.

`meta.notes` now says this, the README support matrix marks INP `✓` for firefox, and long tasks are
correctly attributed to the absent DevTools trace (not to an absent `longtask` observer — wpd never
used one).
