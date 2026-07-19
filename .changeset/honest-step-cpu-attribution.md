---
"@jantimon/web-performance-debugger": patch
---

Makes per-driver-step CPU attribution honest across navigation. On a `--breakdown` journey the V8 CPU
profiler resets on every cross-document navigation, so `Profiler.stop` returns only the samples since
the run's LAST navigation: every step's iteration-0 window (and early `performance.measure`
occurrences) ran before that point, so its bar showed real JS ms but an empty `js.byPackage` and a hot
list suppressed as "0 pooled samples — raise --iterations". Raising iterations cannot recover a window
the sampler never covered, so that hint was misleading.

`query span` now distinguishes why a per-span hot tally is empty (new `suppressionReason` on the JSON
`hot`): `below-floor` (a thin-but-real pool — raise --iterations), `no-js` (the window ran nothing to
rank), or `not-covered` (the bar attributes real JS but the sampler recorded none — the navigation
gap, where more iterations do not help). `record --breakdown` also emits a note when the sampler's
first sample lands after the run window opened and a step/measure bar attributes JS it never covered.
The trace-measured bar ms stay correct; only the sample-derived package/hot split of that JS is
unavailable for pre-navigation windows. Steps the sampler DID cover (any non-navigating step)
attribute in full, unchanged.
