---
"@jantimon/web-performance-debugger": minor
---

**Breaking: rendering counts no longer scale with `--iterations`.** A count now describes the first
timed iteration, so `assert --max-layouts 30` means the same thing at `--iterations` 1 and 50. Expect
`layoutCount` and friends to drop by roughly your iteration count. `--no-isolate` and
`--target firefox` cannot separate counts from wall and now say so in `meta.notes` instead of
reporting totals silently.

**Breaking: bench `wallMs` is now the sum of the timed iterations, not a trace-pass window.** `wallMs`
excludes settle and is measured with tracing off, so it will differ from 0.5.x and `--max-wall`
thresholds may need re-baselining. `perIteration` and `stats` are unchanged.

Added: `--iterations` and `--warmup` now work in driver mode, not just `--bench`. Each iteration
re-measures every step, so a step reports the median of its samples plus min/max in the new
`StepIndexEntry.stats`, which `query index` prints. Step labels must be unique within an *iteration*
rather than the whole run, and every iteration must measure the same steps or the run fails.

Added: `meta.blameSemantic` records whether forced-layout blame names the `flush-site` (Chrome: the
geometry read) or the `invalidation-site` (Firefox: the write that dirtied the DOM), which is why
blame is not comparable across engines. `query blame` prints the semantic under the forced rows.

Fixed: numeric options reject non-integers instead of swallowing them. `--iterations abc` became
`NaN` and recorded a run reporting zero layouts; `--warmup 1.5` silently became `1`. Both now error,
as does any non-integer passed to `--settle`, `--cpu-interval`, `--top` or `--max-*`.
