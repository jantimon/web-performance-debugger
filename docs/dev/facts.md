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
| Sampler contamination during tracing | +21% self-time inflation | 21% | docs/dev/cpu-profiling.md (why the CPU pass is separate) | src/record/passplan.ts, src/trace/categories.ts, docs/dev/cpu-profiling.md, CLAUDE.md |
| Folded reflow in browser-lane self-time | ~85% of the layout probe's "JS" is reflow | 85% | docs/dev/cpu-profiling.md (what self-time includes) | src/model/recording.ts, docs/dev/cpu-profiling.md, docs/dev/README.md, CLAUDE.md |
| Frame cadence, new-headless (~60 Hz) | 16.6 ms one-frame floor | 16.6 | docs/dev/frame-floor.md | src/record/notes.ts, src/browser/launch.ts, docs/dev/frame-floor.md |
| Frame cadence, shell-headless (~120 Hz) | 8.3 ms one-frame floor | 8.3 | docs/dev/frame-floor.md | src/record/notes.ts, src/browser/launch.ts, docs/dev/frame-floor.md, docs/dev/cpu-profiling.md |
| Driver settle floor | ~31 ms new-headless (~half on shell) | ~31 | docs/dev/driver-timing.md | src/browser/driver.ts, src/commands/query.ts, docs/dev/driver-timing.md, docs/dev/README.md, docs/dev/frame-floor.md |
| Firefox forced-layout ms under-report | ~7x low vs Chrome | 7x | docs/dev/engine-mapping.md (forced-layout blame) | docs/dev/engine-mapping.md, CLAUDE.md |
| Paint count exactness | exactly N+1 for N dirtied regions | N+1 | docs/dev/rendering-counts.md | src/trace/taxonomy.ts, src/model/recording.ts, src/commands/diff.ts, docs/dev/rendering-counts.md |
| Default CPU sampler interval | 200 us | 200 | docs/dev/cpu-profiling.md (why 200) | src/profile/cpuprofile.ts, docs/dev/cpu-profiling.md |
| Fused (--breakdown) pass wall cost | ~2-5% above a pristine timing pass | 2-5% | src/record/passplan.ts (breakdownSpec) | src/record/passplan.ts, src/record/notes.ts |
| Firefox honest idle via threadCPUDelta | js,cpu populates the CPU column; a pure-wait window reads 95.7% idle (js-only leaves it 0% populated) | 95.7% | docs/dev/cpu-profiling.md | src/browser/launch.ts, src/profile/gecko.ts, src/record/notes.ts, docs/dev/cpu-profiling.md |
| Frame side-track swing on unchanged code | PipelineReporter total swings 1->28 on an identical 20-box paint | 1->28 | docs/dev/rendering-counts.md (the off-thread frame side track is display-only) | src/trace/frames.ts, docs/dev/rendering-counts.md |
