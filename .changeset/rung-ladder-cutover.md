---
"@jantimon/web-performance-debugger": minor
---

**Breaking: one capture pass per `record`, selected by a rung flag.** The two-pass isolation and its
negative-flag family are gone; every invocation is exactly one pass.

- Rungs replace the flags: default is the four-slice CPU bar (no rendering counts); `--breakdown` is
  the reconciling seven-slice bar plus exact layout/style/paint counts; `--deep` is the attribution
  report (forced-by, dirtied-by, thrash, invalidation rollup, exact counts, no slice ms); `--precise-wall`
  is a sampler-off benchmark wall. Removed: `--no-isolate`, `--no-trace`, `--no-cpu-profile`,
  `--no-invalidation-tracking`, `--fn`, `--cpu-interval`, `--settle`, `--screenshot`, `--network`. Want
  the bar and the blame in one shot? Run `wpd` twice.
- Counts are now trace-derived and windowed to the renderer main thread (the CDP `getMetrics` counters
  are gone). `layoutMs`/`styleMs`/`paintMs` are wall-tier (~1%, directional), measured only on the
  `--breakdown` light trace and reported `null` on `--deep`.
- Driver step walls are re-priced on the page's own clock (the trace-clock window between a step's
  marks, or the page's `performance.now` delta), never the node-side `page.click` bound.
- One artifact file per run (schema `3`): the recording carries the run summary and every span, with
  the classified event log inlined only under `--deep`/firefox. `query digest` and `query index` are
  removed — use `query spans` for the overview, then `query span <label>` for one span's anatomy.
  Recordings written by an older wpd are rejected on read: re-record.
