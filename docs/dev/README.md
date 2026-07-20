# Developer notes (internal)

> **Not user documentation.** Nothing here is needed to *use* wpd — read the
> [README](../../README.md) for that, or [CLAUDE.md](../../CLAUDE.md) for the architecture map.
> These files record empirically-verified facts that the code depends on but cannot state itself,
> so that whoever touches that code next does not have to re-derive them from a browser.

Everything here is **measured, not read off vendor docs** (with one flagged exception, the
market-research file below). Both engines' public docs are silent or wrong on most of this. Claims
are marked **[measured]** (reproduced locally, usually against `examples/forces-layout.mjs` in
both engines) or **[source]** (read out of mozilla-central / chromium at tip-of-tree, with a
permalink).

## Read this file before touching that code

| File | Read it before |
| --- | --- |
| [cpu-profiling.md](./cpu-profiling.md) | changing the capture modes, the sampler interval, or how `selfMs` is described |
| [cpu-attribution.md](./cpu-attribution.md) | changing which spans carry CPU samples, the per-span hot list, or the sourcemap warning |
| [firefox-cpu.md](./firefox-cpu.md) | changing the `MOZ_PROFILER_*` config, the Gecko interval, or the firefox idle/bar computation |
| [blame-semantics.md](./blame-semantics.md) | touching `markForced`, the thrash detector, a dirtied-by report, or any blame claim |
| [engine-mapping.md](./engine-mapping.md) | touching `trace/classify.ts` or `profile/gecko.ts`, or claiming any number is comparable across engines |
| [gecko-profile-format.md](./gecko-profile-format.md) | touching the Gecko converter, or debugging a Firefox dump that stopped parsing |
| [driver-timing.md](./driver-timing.md) | touching `browser/driver.ts`, or presenting a step's `wallMs` as a cost |
| [frame-floor.md](./frame-floor.md) | changing the headless mode, adding a headless flag, or explaining why libraries with different cost report the same `wallMs` |
| [rendering-counts.md](./rendering-counts.md) | adding a name to `trace/classify.ts`, gating a count in `diff.ts`/`assert.ts`, or calling a count "exact" |
| [trace-buffer.md](./trace-buffer.md) | changing `trace/tracing.ts`, the trace buffer size, or claiming a `--deep` count is exact on a heavy page |
| [facts.md](./facts.md) | changing any load-bearing measured number (a ledger of them + the files that must agree, checked by a unit test) |
| [core-features.md](./core-features.md) | writing user-facing copy, prioritizing features, or claiming a capability is unique. The one file here whose evidence is market research (competitor docs and issue threads, link-verified and dated) rather than engine probes |

## Find it by question

**The CPU sampler and the capture modes** — [cpu-profiling.md](./cpu-profiling.md)

- What does `selfMs` include (spoiler: not pure JS)? -> [what self-time actually includes](./cpu-profiling.md#what-self-time-actually-includes)
- What does each capture mode capture, and why is `--breakdown` one fused pass? -> [the capture modes](./cpu-profiling.md#the-capture-modes)
- Why does the sampler open at `wpd:run:start`, not before `prepare()`? -> [the sampler opens at the run mark](./cpu-profiling.md#the-sampler-opens-at-the-run-mark-not-before-prepare)
- Why must the sampler never ride a `.stack` trace (+21%, ~4.6x)? -> [never rides `.stack`](./cpu-profiling.md#why-the-sampler-never-rides-a-stack-trace)
- Are trace durations worse than CDP's counters? (No.) -> [trace durations vs CDP](./cpu-profiling.md#layoutmsstylemspaintms-are-trace-durations-and-cdp-would-be-no-finer)
- Why 200us, and what does sampling cost the wall? -> [the interval](./cpu-profiling.md#the-sampler-interval-why-200us), [the wall cost](./cpu-profiling.md#the-sampler-costs-wall-and---precise-wall-reclaims-it)
- Can work below one frame be measured at all? -> [sub-frame CPU](./cpu-profiling.md#sub-frame-cpu-work-is-measurable-on-both-engines-off-the-frame-floor-axis)

**Where CPU samples land** — [cpu-attribution.md](./cpu-attribution.md)

- Which span kinds carry CPU in which capture mode? -> [the coverage matrix](./cpu-attribution.md#which-spans-get-cpu-attribution)
- Why does a navigating flow lose samples in the default capture mode but not `--breakdown`? -> [navigation reset vs continuity](./cpu-attribution.md#the-cdp-samplers-window-resets-on-a-cross-process-navigation-the-default-capture-mode---breakdown-does-not)
- How does `query span` rank a span's hot functions honestly? -> [per-span hot functions](./cpu-attribution.md#per-span-hot-functions)
- When can the package rollup be believed, and when must it warn? -> [sourcemap note gating](./cpu-attribution.md#sourcemap-note-gating)

**The Firefox lane** — [firefox-cpu.md](./firefox-cpu.md), [gecko-profile-format.md](./gecko-profile-format.md)

- Why do samples and markers share one gecko pass? -> [shared pass](./firefox-cpu.md#samples-and-markers-share-a-pass-unavoidably)
- Where does firefox idle come from (`threadCPUDelta`, not a category)? -> [honest idle](./firefox-cpu.md#firefox-idle-is-on-the-cpu-axis-not-the-category-axis)
- Why `js,cpu` at 1 ms, and why not 0.5 ms or `stackwalk`? -> [the sampler config](./firefox-cpu.md#the-firefox-sampler-config-jscpu-1-ms-and-what-not-to-chase)
- What does the raw v34 dump actually look like (schemas, bases, cause stacks)? -> [gecko-profile-format.md](./gecko-profile-format.md)
- What can Puppeteer/BiDi do on Firefox (and what only looks CDP-only)? -> [capability probe](./gecko-profile-format.md#puppeteer--firefox-capability-probe-verified)
- What is not measured on Firefox, and what is measured but misleading? -> [the honest list](./gecko-profile-format.md#what-is-not-measured-on-firefox-reported-honestly-never-as-fake-zeros)

**Blame** — [blame-semantics.md](./blame-semantics.md)

- Is wpd's forced-layout rule DevTools' rule? (No.) -> [markForced vs DevTools](./blame-semantics.md#wpds-markforced-is-not-devtools-rule-either)
- Why does Chrome blame the read and Gecko's cause stack name the write? -> [blame differs by engine](./blame-semantics.md#forced-layout-blame-differs-by-engine)
- How do dirtied-by and the thrash detector work on Chrome `--deep`? -> [Chrome's write side](./blame-semantics.md#chromes-write-side-dirtied-by--the-thrash-detector---deep)
- Why does firefox `--deep` report one write per flush and no thrash count? -> [Firefox's write side](./blame-semantics.md#firefoxs-write-side-partial-dirtied-by-first-invalidation-only---deep)

**Cross-engine vocabulary and comparability** — [engine-mapping.md](./engine-mapping.md)

- What is the Gecko name for this Blink event (and the traps in between)? -> [the naming map](./engine-mapping.md#the-naming-map)
- Which numbers may be compared across engines at all? -> [what is actually comparable](./engine-mapping.md#what-is-actually-comparable-across-engines)
- How does the firefox bar split style from layout? -> [`layoutSlice`](./engine-mapping.md#style-vs-layout-in-the-reconciling-bar-layoutslice)

**Timing, wall, and the frame floor** — [driver-timing.md](./driver-timing.md), [frame-floor.md](./frame-floor.md)

- What does a driver step's `wallMs` actually time? -> [the page's own clock](./driver-timing.md#a-driver-steps-wallms-is-the-pages-own-clock-not-a-node-side-bound)
- Which step signals are drive-independent? -> [what describes the page](./driver-timing.md#what-does-describe-the-page)
- How is INP split into input/processing/presentation, and why group by `interactionId`? -> [the CWV split](./driver-timing.md#the-cwv-split-and-why-it-needs-interactionid)
- Settle heuristics, `waitForStable`, LoAF, measure merging — the sharp edges -> [limits](./driver-timing.md#limits-worth-knowing-before-you-rely-on-it)
- Why do different-cost libraries report the same wall? -> [the one-frame floor](./frame-floor.md#it-is-a-floor-not-quantization)
- Why shell-headless (120 Hz) by default? -> [the mode decision](./frame-floor.md#the-mode-decision)

**Counts and the trace** — [rendering-counts.md](./rendering-counts.md), [trace-buffer.md](./trace-buffer.md)

- Which counts may gate CI, and which must never? -> [the rule](./rendering-counts.md#the-rule)
- Do trace counts match CDP's counters? -> [1:1, parses excluded](./rendering-counts.md#layout-and-style-counts-match-the-cdp-counters-11)
- What scope is a count (OOPIF, process swaps, re-anchoring)? -> [main-thread windowed](./rendering-counts.md#the-count-is-main-thread-windowed-the-trace-is-browser-wide), [the navigation re-anchor](./rendering-counts.md#the-main-thread-follows-a-cross-process-navigation)
- Why is `Paint` exact, and why is there no composite count? -> [Paint is per-chunk](./rendering-counts.md#paint-is-exact-and-it-is-per-chunk), [no composite count](./rendering-counts.md#there-is-no-composite-count-deliberately)
- Why do a run's counts and its bar cover different windows? -> [count window vs bar window](./rendering-counts.md#the-run-count-window-and-the-run-bar-window-differ-by-design)
- What overruns the trace buffer, and what is the parse ceiling? -> [trace-buffer.md](./trace-buffer.md)

## The four things most likely to bite you

1. **Counts TOTAL across `--iterations` on every counting capture mode.** Every invocation is exactly ONE
   pass, which runs every iteration for the wall samples, so `layout/style/paint/forced` are totals,
   not one iteration's work, so `assert --max-layouts` silently scales with `--iterations`.
   `countScopeNote` says so; use `--iterations 1` to assert on counts. And a `Measured<>` field a capture mode
   did not measure is `null`, never 0 (`--breakdown` reports `forcedLayoutCount`/`forcedLayoutMs` as
   `null`, since forced needs `.stack`): `assert` FAILs on `null`, so `assert --max-forced 0` fails
   under `--breakdown` by design, rather than passing on a fake 0. Firefox is the same model: its
   unmeasured counts (paint, invalidations, long tasks) report `null`/`—`, never a fake 0.
2. **`selfMs` on the browser lanes is not pure JS.** It is JS *plus the synchronous engine work JS
   triggered* — a forced layout shows up as self-time on the line that forced it (~85% of the
   probe's "JS" time is reflow). Only `--target node` measures pure JS.
   [Details](./cpu-profiling.md#what-self-time-actually-includes).
3. **The sampler never rides a `.stack` trace.** Sampling on a `.stack` trace inflates self-time +21%,
   because our own `devtools.timeline.stack` category makes Blink walk the JS stack on every Layout and
   bill it to the forcing JS frame. So the sampler rides only the light `--breakdown` trace or no trace
   (default); `--deep`, which needs `.stack`, runs it OFF.
   [Details](./cpu-profiling.md#why-the-sampler-never-rides-a-stack-trace).
4. **A driver step's `wallMs` is the page clock, and mostly its settle.** The stored wall is the page's
   own clock (the trace-clock window between the step's marks on `--breakdown`/`--deep`, else the
   page's `performance.now` delta), not a node-side bound. That bound would read 40.5 ms via
   `page.click`, 31.9 ms via `page.evaluate`, 1.1 ms in `--bench`, because it carries the tool's
   dispatch in no renderer timeline. Even on the page clock the window includes the deliberate settle
   (floor ~31 ms under new-headless `--headless-mode new`, ~half on the default shell mode), so use
   `interaction.processingMs` or the per-step counts for what the page did.
   [Details](./driver-timing.md#a-driver-steps-wallms-is-the-pages-own-clock-not-a-node-side-bound).

## How to add a claim here

**Run the probe in both engines before writing the sentence.** A plausible mechanism is not
evidence: engine behaviour is only knowable by measuring it, and the notes above exist because the
obvious answer and the measured one differ often enough that the difference is the point.

Two corollaries worth applying:

- **A diagnosis that predicts the right magnitude can still name the wrong cause.** "This wall is
  too big" and "the CDP round trip is why" are separate claims; only the second needs a probe. A fix
  derived from an unmeasured mechanism ships the wrong column even when the symptom was real.
- **A default does not just change behaviour, it changes which latent bugs are load-bearing.** A
  warning that only fires for opted-in users is barely tested; flipping the default is the moment to
  re-read every warning it now reaches.

House rules for these files: every file opens with a "not user documentation" note, an **In this
file** anchor list, and a **Provenance** line naming the probes; a moved or split section keeps its
heading text so anchors survive; a load-bearing number cited in more than one file gets a
[facts.md](./facts.md) ledger row, and the ledger unit test keeps the copies from drifting.
