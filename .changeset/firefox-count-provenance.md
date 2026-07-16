---
"@jantimon/web-performance-debugger": patch
---

Stop Firefox runs claiming their rendering counts are authoritative, and stop claiming they are absent

A single Firefox run made two contradictory claims about the same numbers, and both were wrong.
The report printed `Rendering work (counts are authoritative; durations are coarse)` — an
unconditional header — above a table reading `layout 7, style recalc 15`, while that run's own
`meta.notes` said `exact layout/style/script counts ... are NOT measured`.

The counts do exist. Firefox has no CDP, so the summary falls back to counting the Gecko
profiler's `Reflow`/`Styles` markers: `layoutCount`, `styleCount` and `forcedLayoutCount` are real
and useful. But they are not authoritative — Gecko batches layout differently than Blink, so they
count a different thing than Chrome's CDP counters. Telling users they were authoritative invited
diffing them straight against a Chrome run and drawing a nonsense conclusion; telling users they
were unmeasured hid a working signal.

Now the header names its lane: CDP counters are authoritative, Gecko-marker counts say so and say
they are not comparable to Chrome, and a Firefox run without `--cpu-profile` (which has no
counting mechanism at all, so every count is `0`) says that instead of implying the page was
clean. The Firefox note names exactly which fields are measured, which are a hard `0`, and what
the measured ones may be compared against.

The README's "never fake zeros" claim is corrected in the same spirit: `paintCount`,
`compositeCount`, the invalidation counts, long tasks and `scriptingMs` are all reported as `0` on
Firefox because nothing measures them. That gap is unchanged here — reporting "not measured"
distinctly from `0` needs per-field availability metadata — but it is now documented rather than
denied.
