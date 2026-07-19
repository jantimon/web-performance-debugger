# Load-bearing measured facts (ledger)

The numbers the code depends on but cannot state in one place: each is `[measured]` (see the
canonical doc for the probe) and cited in several source files and docs, which must not drift apart.
A unit test (`test/unit/model.test.mjs`, "facts.md ledger") reads this table and asserts every file in the
**Cited in** column still contains the **Test string**, so changing a number in one place and not the
others fails the build.

Keep the **Test string** distinctive enough that it only matches this fact (the Firefox
forced-layout `7x` and the composite-swing `7x` are different facts, so the latter's files are not
listed here), and only list a file that genuinely contains the string.

| Fact | Value | Test string | Canonical anchor | Cited in |
| --- | --- | --- | --- | --- |
| Sampler contamination during tracing | +21% self-time inflation | 21% | docs/dev/cpu-profiling.md (why the sampler never rides a .stack trace) | src/record/capture.ts, src/trace/categories.ts, docs/dev/cpu-profiling.md, CLAUDE.md |
| Folded reflow in browser-lane self-time | ~85% of the layout probe's "JS" is reflow | 85% | docs/dev/cpu-profiling.md (what self-time includes) | src/model/recording.ts, docs/dev/cpu-profiling.md, docs/dev/README.md, CLAUDE.md |
| Frame cadence, new-headless (~60 Hz) | 16.6 ms one-frame floor | 16.6 | docs/dev/frame-floor.md | src/record/notes.ts, src/browser/launch.ts, docs/dev/frame-floor.md |
| Frame cadence, shell-headless (~120 Hz) | 8.3 ms one-frame floor | 8.3 | docs/dev/frame-floor.md | src/record/notes.ts, src/browser/launch.ts, docs/dev/frame-floor.md, docs/dev/cpu-profiling.md |
| Driver settle floor | ~31 ms new-headless (~half on shell) | ~31 | docs/dev/driver-timing.md | docs/dev/driver-timing.md, docs/dev/README.md, docs/dev/frame-floor.md |
| Firefox forced-layout ms under-report | ~7x low vs Chrome | 7x | docs/dev/engine-mapping.md (forced-layout blame) | docs/dev/engine-mapping.md, CLAUDE.md |
| Paint count exactness | exactly N+1 for N dirtied regions | N+1 | docs/dev/rendering-counts.md | src/trace/taxonomy.ts, src/model/recording.ts, src/commands/diff.ts, docs/dev/rendering-counts.md |
| Default CPU sampler interval | 200 us | 200 | docs/dev/cpu-profiling.md (why 200) | src/profile/cpuprofile.ts, docs/dev/cpu-profiling.md |
| Fused (--breakdown) pass wall cost | ~2-5% above the sampler-only default rung | 2-5% | src/record/capture.ts (the breakdown rung) | src/record/capture.ts, src/record/notes.ts |
| Fused (--breakdown) pass CPU cleanliness | light trace leaves sampled self-time clean vs sampler-only | +0-1% | docs/dev/cpu-profiling.md (the rung ladder, --breakdown bullet) | src/record/capture.ts, docs/dev/cpu-profiling.md |
| Firefox read-site blame line overlap with Chrome | 12 of Chrome's 21 forced read lines matched exactly | 12/21 | docs/dev/engine-mapping.md (forced-layout blame) | docs/dev/engine-mapping.md, src/model/recording.ts |
| Firefox sub-ms sampling declined (keep the 1ms floor) | 0.5ms is delivered on macOS but worsens reconciliation/size | 0.499 | docs/dev/cpu-profiling.md (the Firefox sampler config) | docs/dev/cpu-profiling.md |
| Firefox honest idle via threadCPUDelta | js,cpu populates the CPU column; a pure-wait window reads 95.7% idle (js-only leaves it 0% populated) | 95.7% | docs/dev/cpu-profiling.md | src/browser/launch.ts, src/profile/gecko.ts, src/record/notes.ts, docs/dev/cpu-profiling.md |
| Frame side-track swing on unchanged code | PipelineReporter total swings 1->28 on an identical 20-box paint | 1->28 | docs/dev/rendering-counts.md (the off-thread frame side track is display-only) | src/trace/frames.ts, docs/dev/rendering-counts.md |
| ParseAuthorStyleSheet excluded from the style count | a stylesheet parse, not a recalc: Blink logs it without incrementing RecalcStyleCount | ParseAuthorStyleSheet | docs/dev/rendering-counts.md (Layout and style counts match the CDP counters 1:1) | src/trace/taxonomy.ts, docs/dev/rendering-counts.md |
| Layout/style counts match CDP 1:1 per event | trace Layout == LayoutCount, trace UpdateLayoutTree == RecalcStyleCount (parses excluded) | 1:1 with zero variance | docs/dev/rendering-counts.md (Layout and style counts match the CDP counters 1:1) | docs/dev/rendering-counts.md |
| Trace layout duration vs CDP LayoutDuration | trace-summed dur runs 0.3-1.0% below CDP LayoutDuration, systematic, on the light trace | -0.3..-1.0% | docs/dev/cpu-profiling.md (layoutMs/styleMs are trace durations) | docs/dev/cpu-profiling.md |
| .stack inflates real style-recalc duration | ~4.6x higher recalc with .stack (CDP ~234ms vs ~51ms); trace and CDP agree on both sides | 4.6x | docs/dev/cpu-profiling.md (why the sampler never rides a .stack trace) | docs/dev/cpu-profiling.md |
| .stack trace inflates the style-recalc duration (--deep suppresses slice ms) | style dur up to +38% on a `.stack` trace, so `--deep` reports layoutMs/styleMs/paintMs null | +38% | docs/dev/cpu-profiling.md (layoutMs/styleMs are trace durations) | src/metrics/summarize.ts, src/record/notes.ts, src/model/recording.ts, docs/dev/cpu-profiling.md, CLAUDE.md, README.md |
| OOPIF count scoping: top process vs all pids | getMetrics is top-process (6); the trace across all pids sums to 18 = 6 + 12 | 18 = 6 + 12 | docs/dev/rendering-counts.md (the count is main-thread-windowed) | docs/dev/rendering-counts.md |
| Thrash detector matches invalidation-write kind to flush kind | matching-kind counts 42 of 43 forced flushes on the probe; the dropped one is the focus() clean re-read | 42 of 43 | docs/dev/engine-mapping.md (Chrome's write side: dirtied-by + the thrash detector) | src/trace/thrash.ts, docs/dev/engine-mapping.md |
| Gecko style-wrapper labels under-count style | ~10-25% of style recalc buckets to layout without the wrapper/diff/stylist style labels | 10-25% | docs/dev/engine-mapping.md (Style vs layout in the reconciling bar) | src/profile/gecko.ts, docs/dev/engine-mapping.md |
