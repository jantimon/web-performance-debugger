---
"@jantimon/web-performance-debugger": minor
---

**Breaking:** rendering counts no longer scale with `--iterations`. They describe the first timed
iteration, so `assert --max-layouts 30` means the same at `--iterations` 1 and 50; before, it passed
at 1 and failed at 10 on an unchanged page (`layoutCount` 22 → 102 → 202). Expect counts to drop by
roughly your iteration count. Two lanes cannot do this and now say so in `meta.notes` instead of
reporting totals silently: `--no-isolate` (one pass carries wall and counts) and `--target firefox`
(its count pass is also its only CPU sampler).

**Breaking:** bench `wallMs` is now the sum of the timed iterations, not a trace-pass window: it is
measured with tracing off and excludes settle, so it will differ from 0.5.x and `--max-wall`
thresholds may need re-baselining. `perIteration`/`stats` are unchanged.

**Added:** `--iterations` / `--warmup` now work in driver mode, not just `--bench`. Each iteration
re-measures every step, so a step reports the median of its samples plus min/max instead of a single
reading that cannot separate a regression from noise. Step labels must be unique within an
*iteration* rather than within the run, and every iteration must measure the same steps or the run
fails. For a fresh page each iteration, put a bare `page.goto(url)` in `run` outside any
`measureStep` — there is no reset flag.

**Added:** `meta.blameSemantic` says whether forced-layout blame names the `flush-site` (Chrome: the
geometry read) or the `invalidation-site` (Firefox: the write that dirtied the DOM). The two share
zero lines, so a cross-engine consumer can refuse the comparison instead of making it wrongly.
`query blame` prints it under the forced rows, and `StepIndexEntry.stats` exposes each step's spread
in `query index`.

**Fixed:** numeric options now reject what they used to swallow. `--iterations abc` became `NaN`,
failed every range check (comparisons with `NaN` are false), and recorded a run reporting zero
layouts — indistinguishable from a clean page. `--warmup 1.5` silently became 1. Both now error,
as does any non-integer passed to `--settle`, `--cpu-interval`, `--top`, `--max-*` and friends.
