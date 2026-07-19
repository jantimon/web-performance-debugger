# CPU profiling: rungs, contamination, and what self-time means (internal)

> **Developer notes, not user documentation.** Read the [README](../../README.md) to use wpd. This
> file records why the rung ladder is shaped the way it is, with the measurements behind it, so the
> next person does not "optimise" the structure into a wrong number.

Related: [engine-mapping.md](./engine-mapping.md) (Gecko <-> Blink names and semantics),
[gecko-profile-format.md](./gecko-profile-format.md) (raw dump schemas).

**Provenance.** Rung-structure numbers are 5 interleaved runs per arm, after a discarded warmup, of
`examples/forces-layout.mjs --bench` on chrome 150 / firefox 152; interval numbers are 3 runs per arm
of `examples/cpu-busywork.mjs --target node`. First-run numbers are cold-start outliers by a wide
margin (a single un-warmed run reads 18ms against a 7ms median, enough to "prove" the wrong
conclusion) — **always warm up and interleave** before believing a rung A/B.

## What self-time actually includes

**[measured]** The headline fact, and it is not what "CPU profile" suggests.

On the browser lanes, `selfMs` is **JS plus the synchronous engine work that JS triggered** — not
pure JS. The default rung (sampler, tracing off) on the forced-layout probe:

```
8.41 ms   fn=run    examples/forces-layout.mjs:24
0.20 ms   fn=elementFromPoint   (native)
```

The probe's actual JavaScript is a couple dozen property reads — microseconds. But a `.stack` trace
independently measures **7.17ms of forced layout**, and `run()`'s wall is 8.3ms. So ~85% of that
"JS self-time" **is the reflow**, attributed to the JS frame that forced it. The V8 sampler walks
the JS stack; time spent in Blink C++ under a DOM accessor lands on the calling JS frame.

Firefox does the same thing, and lands in the same place (`run()` at **8.79ms**).

This is **correct and useful**, not a bug: "delete this line and the page gets ~8ms faster" is
exactly the actionable answer. It also means `query cpu` already gives forced-layout attribution to
the *forcing* line on both engines — including on Firefox, where `query blame` gets it wrong (see
[engine-mapping.md](./engine-mapping.md#forced-layout-blame-differs-by-engine)).

But it constrains what may be claimed:

- **`--target node`**: no DOM, so self-time really is pure JS cost. The SSR / `renderToString`
  framing is accurate here and only here.
- **browser lanes** (`--bench`, driver): self-time is JS + synchronous engine work. Do not describe
  it as "pure JS cost".

## The rung ladder

Every invocation is exactly ONE capture pass: one browser launch, one run of the flow, one recording.
A rung picks WHAT that pass captures, never how many passes run. `captureFor()` in
`src/record/capture.ts` is the authority.

```
chrome default:        [sampler]                     four-slice CPU bar; no rendering counts
chrome --breakdown:    [light-trace + sampler]       seven-slice reconciling bar + exact counts
chrome --deep:         [full trace, sampler OFF]     forced-layout blame + exact counts, no bar
chrome --precise-wall: [no trace, no sampler]        pristine benchmark wall, nothing else
firefox:               [gecko]                        one pass; every rung is a reporting tier over it
node:                  [node-cpu]                     in-process V8, four-slice bar (engine slice "native")
```

- **default**: the CPU sampler alone, no DevTools trace, for the cleanest wall (~1%). Reports the
  four-slice CPU bar (`js · browser · gc · idle`) and no rendering counts, so
  layout/style/paint/forced are `Measured` null, never 0.
- **--breakdown**: ONE fused pass: a light trace (the shipped categories MINUS
  `disabled-by-default-devtools.timeline.stack` and MINUS `invalidationTracking`, plus gc events)
  with the sampler riding it. Trace events and samples share a clock, so the seven-slice
  `js · style · layout · paint · gc · other · idle` bar reconciles, and it carries exact
  layout/style/paint counts. **[measured]** the light trace leaves self-time clean (**+0-1%** vs the
  sampler-only baseline, no invented functions) and costs **~2-5%** wall (probes A-C); dropping
  `.stack` is what removes the +21% contamination below. Being one pass it runs every iteration, so
  counts total across `--iterations`; forced counts and blame need `.stack`, so this rung reports
  them `null`, never 0.
- **--deep**: ONE full trace (`.stack` + `invalidationTracking`) with the sampler OFF: forced-layout
  blame (read-site), dirtied-by writes, the thrash detector, invalidation rollup, exact counts and
  long tasks. No CPU model and no reconciling bar. Slice durations are suppressed (`.stack` inflates
  them, style up to +38% below); the span's wall (window width) is still reported.
- **--precise-wall**: the default rung minus the sampler: a pristine benchmark wall, no sampler
  perturbation, no counts, no CPU model.
- **gecko**: firefox only; one Gecko-profiler run yields CPU samples *and* layout/style markers. It
  is the firefox lane at every rung (the profiler is a whole-browser-lifetime startup feature), so
  the rungs are reporting tiers over this one capture. `--deep` adds a dirtied-by write report from
  Gecko's native cause stacks; `meta.passes` is `gecko` or `gecko-deep`.
- **node**: `--target node`; the in-process V8 sampler (`runtime/node.ts`), CPU-only, four-slice bar
  with the engine slice labeled `native`.

CPU profiling is **on by default** wherever a rung samples (chrome default and `--breakdown`, firefox,
node) and costs no extra pass. The sampler-free rungs are chrome's `--precise-wall` and `--deep`;
node and firefox have none, because node would measure nothing without the sampler and firefox
without the gecko pass reports every rendering count as 0.

### The sampler opens at the run mark, not before prepare

**[measured]** The V8 CPU model is built from the WHOLE returned profile, never sliced to the run
window: there is no trace clock on the default rung to slice it by, so whatever the sampler recorded
lands in `scriptingMs`, the package rollup, the hot list, and `cpu-diff`. So the sampler's lifetime
IS the measured window, and it opens **right before the `wpd:run:start` mark**, after `prepare()` and
after every warmup iteration (`browser/driver.ts` `beforeRunWindow`, `record/runpass.ts`). `cleanup()`
already runs after the sampler stops.

Opened before `prepare()` instead, it bills every page-side JS that setup ran to the run. On a driver
probe whose `run()` does ~5 ms of page JS and whose `prepare()` does ~80 ms, the whole-profile model
reads **scriptingMs ~88 ms with the setup loop as the top hot function (~84 ms, 95%)** and a ~310 ms
sampled window; a second `--warmup 2` adds the warmup repetitions on top (~99 ms). Opening it at the
run mark reads **scriptingMs ~9 ms**, the run's own cost. The trace COUNTS are windowed to the run
marks regardless (`findWindow`), so on `--breakdown` the trace may start before the sampler; only the
sampler must not. This matches bench, where `prepare()`+warmup already run in a separate `page.evaluate`
before the sampler starts (`runpass.ts` setup phase).

Starting late is safe across navigation: the page CDP session outlives a cross-document navigation
(the on-ramp `--url` load step navigates inside the run window with the sampler already open), so a
`prepare()` that navigates is simply excluded, and a `run()` that navigates behaves as before -- V8
still resets the profile on that navigation, and the `--breakdown` per-span coverage-gap note
(buildBreakdowns) still fires for any pre-navigation step/measure window.

### Why the sampler never rides a `.stack` trace

**[measured]** Sampling is cheap; that is not why the sampler needs a trace it can avoid.
**The `.stack` category contaminating the sampler is.** The load-bearing property of any pass the
sampler rides is that `.stack` is off it: the default rung has no trace at all, and the `--breakdown`
light trace drops `.stack`. `--deep`, which needs `.stack`, runs the sampler **OFF** for exactly this
reason.

Running the sampler on a `.stack` trace ("trace pass" below), against a no-`.stack` baseline:

| sampler runs on | passes | CPU self ms | CPU fns | perIteration ms |
| --- | --- | --- | --- | --- |
| a pass of its own | 3 | **8.67** (8.2–11.4) | 7 | **8.3** (8.0–8.7) |
| **trace pass** (never do this) | 2 | **10.4** (10.0–11.2) | **10** | 8.3 |
| no-`.stack` pass (**shipped**) | 2 | 8.99 (8.3–13.3) | 7 | 9.1 (8.3–13.4) |

A `.stack` trace inflates CPU self-time **+21% with non-overlapping ranges** and invents functions.
The mechanism is our own trace config: `disabled-by-default-devtools.timeline.stack` makes Blink
capture a JS stack on every Layout/UpdateLayoutTree — *while JS is on the stack* — so the sampler
attributes trace-emission cost to the JS function that forced the layout. It is **not uniform**
(top fn +4%, total +21%), so `--by package` proportions shift too.

The insidious part: this lands on the **same frame** as the real forced-layout time described
above. From inside a `.stack` pass the two are indistinguishable. One is production cost; the other
is measurement apparatus that exists only because we asked for it. Reporting 10.4ms for a line that
costs 8.4ms in production is precisely the fake number this project refuses elsewhere.

A **second, independent signal** stands behind the same prohibition: `.stack` inflates *real*
style-recalc time **~4.6x** on a style-churn workload. **[measured]** CDP reads **~234 ms** of recalc
with `.stack` on vs **~51 ms** without, for identical work, and the trace agrees with CDP on **both**
sides (0% apart each). So the category does not merely change the sampler's *view* of recalc time; it
slows the page itself, and CDP's own counter sees the inflation too. Two measurements that share no
apparatus — sampler self-time +21% and real recalc duration ~4.6x — land on the same rule: **never
run the sampler on a `.stack` trace, and never read a style duration off a `.stack` trace.**

Counts are never at risk: `layoutCount`/`styleCount`/`forcedLayoutCount` are byte-identical
(22/23/43) across all 20 runs of the A/B.

### `layoutMs`/`styleMs`/`paintMs` are trace durations, and CDP would be no finer

`layoutMs`/`styleMs`/`paintMs` are summed from the `Layout`/`UpdateLayoutTree`/`Paint` trace events on
the light (`--breakdown`) trace, windowed to the main thread. They are **wall-tier**, not the exact
count tier: `base::TimeTicks` ms, directional at ~1%.

**[measured]** A CDP `LayoutDuration`/`RecalcStyleDuration` counter would be no more trustworthy: it
measures the **same `base::TimeTicks` code region** the trace events do — the same clock, and the same
`.stack` inflation above. On the light (no-`.stack`) set, the trace-summed `Σ dur` tracks the CDP
deltas closely: layout to **-0.3..-1.0%** (systematic, trace slightly under, non-compounding with
event count) and style to **~0.01 ms** absolute (the relative % is large only where style work is
itself sub-0.1 ms). There is **no accuracy tier between the two sources**: both are wall-tier
`base::TimeTicks` ms (directional, ~1%) of the same region — not the exact count tier, and not the
profiler's own clock. A `.stack` trace inflates the
style duration and must never feed a duration compared against a no-`.stack` one. The **+38%** here
and the **~4.6x** above are different workloads, not a contradiction: this is a layout-dominated
comparison set where style is sub-0.1 ms absolute, so a few-microsecond `.stack` delta reads as a
large percent; the ~4.6x is the style-churn probe where recalc *is* the work (~234 ms vs ~51 ms).
Same direction — `.stack` slows recalc — with magnitude that scales with how much style work there is.

### Do not "correct" the contamination arithmetically

It is tempting: a `.stack` trace knows exactly which forced events fired on which source line, so a
per-line subtraction (~1.7ms / 43 events ~= 40us each) looks derivable. Don't. That constant is
**fitted, not measured** — it varies with stack depth — and it would inject a modeled correction
into the one signal the trust table calls "real: trustworthy in aggregate". Running the sampler off
a `.stack` trace removes the error instead of modelling it. Prefer the design where the number is
measured.

### The sampler costs wall, and `--precise-wall` reclaims it

**[measured]** The sampler adds no pass (it is on or off the one capture), but it does cost wall on
the rung it rides: **perIteration +10% median and ~3x the variance** at a 50us interval, most of
which the 200us default below buys back. The CPU model itself is intact (+4%, overlapping ranges,
same function count).

That trade respects the existing trust hierarchy — wall is declared *directional*, CPU self-time is
declared *real* — and systematic inflation cancels in `diff`, where both sides carry it. So the
sampled rungs (default, `--breakdown`) are not pristine on wall, which is what `--precise-wall` is
for: clean-wall and `--iterations` benchmarking work.

### The sampler interval: why 200us

**[measured]** `50us` — **20x more aggressive than V8's own 1000us** — is where most of the
timing-fold's wall cost comes from.

Tuned against `examples/cpu-busywork.mjs` (**~2.2 seconds** of real JS), *not* the layout probe. A
layout probe is the wrong workload for tuning a JS sampler: it has ~8ms of JS, so any coarsening
starves it and looks catastrophic. Measuring on the probe suggests 200us "collapses" resolution from
7 functions to 3; on a real JS workload that effect does not exist.

| interval | self ms (median) | perIteration ms | functions |
| --- | --- | --- | --- |
| 50us | 2348.3 | 177.0 | 6 |
| **200us** | **2226.1** | **165.6** | **6** |
| 1000us | 2208.4 | 163.1 | 5 |

Reading it: 1000us is effectively the unperturbed baseline, so 50us **inflates its own measurement
by ~6%** and the wall it rides on by ~8.5%. 200us costs ~1%. And the resolution argument for 50us
does not survive contact: at 50us and 200us the function lists are **identical**, with self-% within
0.3pp (`run` 65.0 vs 64.7, `buildRows` 24.6 vs 24.4, `hashString` 3.6 vs 3.7). The only thing 50us
"finds" extra is sub-0.1ms noise like `now (node:internal/perf/performance)` at 0.0ms, and its
presence varies run to run.

So 200us: ~1% overhead, 5x V8's default resolution, and percentages — the thing `query cpu` actually
reports — stable across a 20x interval change. **Re-measure against a JS-heavy workload if you touch
it.**

`DEFAULT_CPU_INTERVAL_US` lives in `profile/cpuprofile.ts` and is imported by **both** lanes. One
definition, because a lane that declares its own drifts silently: nothing type-checks two constants
into agreement, so a change to the interval lands on one lane while the other keeps sampling at the
old rate and `--help` describes neither. A unit test asserts no lane redeclares it. If you add a
lane, import the constant.

## Firefox: samples and markers share a pass, unavoidably

The gecko pass collects markers *and* samples together — structurally the thing warned against
above, since `profiler_capture_backtrace()` fires on every invalidation. It cannot be separated:
the Gecko profiler is started via `MOZ_PROFILER_STARTUP*` env vars for the whole browser lifetime,
and the `js` feature that yields JS stacks for cause chains is the same feature that yields
samples. So Firefox's CPU model may carry contamination of the same shape as Chrome's `.stack`.

**This has not been measured.** It should be, before Firefox CPU numbers are described as clean.
The one data point that argues against a large effect: firefox `run()` = 8.79ms vs chrome's
uncontaminated 8.41ms, a 5% gap — but that is one probe and the two engines differ for other
reasons too.

### Firefox idle is on the CPU axis, not the category axis

**[measured]** Idle is NOT in Gecko's category axis: a fully-idle window records 0 Idle-category
and 0 null-stack samples, because the leaf frame while waiting is a native frame categorized `Other`
(so `geckoToRawCpuProfile` alone would bill the whole wait to `(program)`). The idle information
lives on a different axis: the per-sample `threadCPUDelta` column (how much CPU the thread actually
consumed since the previous sample). A descheduled thread reads ~0 there while wall-time advances, so
`idleMs = Σ(wall-delta where threadCPUDelta ~= 0)`.

That column is present only when the profiler runs with the `cpu` feature. An explicit
`MOZ_PROFILER_STARTUP_FEATURES` string REPLACES the default set, so `js` alone leaves the column
**0% populated**; `js,cpu` populates it **100%**. Probe:
`examples/awaits-only.mjs`, a `run()` that only awaits (`setTimeout` 20ms x 20, `--bench`), a
~pure-wait window:

| lane | window | idle reported |
| --- | --- | --- |
| Chrome (CDP, 200us) | 614 ms | **610 ms (99%)** — `(idle)` samples fill the wait |
| Firefox (Gecko js,cpu, ~1ms) | 470 ms | **95.7% idle** — samples with `threadCPUDelta ~= 0` |

So the reconciling bar IS emitted on Firefox: `geckoToRawCpuProfile` routes each ~0-CPU sample to
`(idle)` (honest `scriptingMs`), and `computeGeckoCpuBreakdown` tiles the window
`js · style · layout · browser · gc · idle`, with style/layout from each sample's nearest-to-leaf
Layout-category frame. A dump without the CPU signal (an older recording, or js-only) carries no
idle signal, so no bar is emitted rather than a fabricated one. `cpuallthreads` is unnecessary
(`js,cpu` reproduces the idle result, sampling only registered threads) and `stackwalk` adds zero
signal. Paint stays off the bar: it is off-main-thread compositor work (a side track), never summed.

### Sub-frame CPU work IS measurable on both engines, off the frame-floor axis

**[measured]** `wall`/`INP` cannot resolve below one display frame ([frame-floor.md](./frame-floor.md)),
but CPU self-time can, in both engines, and reconciles with the independent `--bench` wall (the
summed timed `run()` samples) to ~1% on JS-bound work. Probe: `examples/fixed-js-work.mjs`, a fixed
~1.5ms JS loop, `--bench`.

| lane | iter=1 | iter=50 | reconciles with bench wall | resolution floor |
| --- | --- | --- | --- | --- |
| Chrome (200us sampler) | js 2.2 ms (bench 2.2) | js 74.1 ms (bench 73.4) | yes, ~1% | ~1.5ms call resolves at iter=1 (~10 samples) |
| Firefox (~1ms sampler) | scriptingMs 2.0 ms (bench 2) | scriptingMs 67.9 ms (bench 65) | yes, ~3% | needs a few ms accumulated; ~5ms over-count floor for near-zero work |

The sampler interval sets the floor: Chrome at 200us prices a single sub-millisecond call (though
at `--iterations 1` a sub-ms call can land 0 samples — the near-zero `console.log` probe
`examples/near-zero.mjs` reads js 0 at iter 10 and only becomes monotonic above ~200 iterations);
Firefox is pinned to Gecko's ~1ms floor
(`GECKO_MIN_INTERVAL_MS`), so a near-zero window reads a fixed ~5ms of a handful of samples and needs
higher `--iterations` before the number is trustworthy. Both prove the point: the work axis reports
what the one-frame `wall`/`INP` floor hides.

### The Firefox sampler config: `js,cpu`, 1 ms, and what not to chase

**[measured]** `examples/cpu-busywork.mjs --bench --target firefox`, interleaved arms, RAW dumps.

- **The 1 ms floor is a measured choice, not the OS limit.** Requesting 0.5 ms *is* delivered on
  macOS — achieved **0.50 ms** median (0.499-0.50 raw over 5 runs), so the `usleep()` floor does
  not hold — but it is declined: it doubles samples for resolution wpd does not use (function lists +
  self-% are interval-stable, above), and it *worsens* the two things that matter — scriptingMs-vs-
  bench-wall reconciliation **+4%->+7%**, dump size **+1.5 MB**, with no fidelity gain. Sub-frame
  fidelity comes from `--iterations` + measure-spans instead.
- **Profiler self-overhead is 0.03-0.13% on the category axis — nothing to subtract.** wpd's dumps
  are unsymbolicated, so sample leaves are raw JIT addresses with no category and the `Profiler`
  category survives only on a handful of pseudo-frames. The sampler's real cost shows up as wall
  (~4% in reconciliation), not as a category slice, so `selfMs` needs no overhead correction.
- **ENTRIES is not a dump-size lever.** The 16M-entry ring is a ~128 MB ceiling never approached;
  size scales with samples *used* (threads x whole-browser-lifetime x features: `cpu` +0.5 MB,
  `stackwalk` +0.7 MB), so a dump is ~15-23 MB regardless of workload. Do NOT shrink it by lowering
  ENTRIES: undersizing silently overwrites (drops) the window's *earliest* samples. `stackwalk`
  stays off (zero signal on shallow JIT stacks, +0.7 MB).

## Which spans get CPU attribution

CPU attribution (the sampler's scripting axis: the run bar's `js` slice and the per-span hot list)
reaches a span only where a sampler rung ran AND that span kind carries a window the samples can be
tallied over. The run span reads the sibling `CpuModel` at query time; a step or measure span carries
stored top-K `SpanHot` refs, which exist only where the fused `--breakdown` trace (or the gecko pass)
gave that span its own window.

| lane / rung | run span | step span | measure span |
| --- | --- | --- | --- |
| chrome default | yes (CpuModel) | no | no (no trace = no measure spans) |
| chrome `--breakdown` | yes (CpuModel) | yes (`SpanHot`) | yes (`SpanHot`) |
| chrome `--deep` | no (sampler OFF) | no | no |
| chrome `--precise-wall` | no (sampler OFF) | no | no |
| firefox (`gecko`/`gecko-deep`) | yes (CpuModel) | no | yes (`SpanHot`) |
| node | yes (CpuModel) | n/a (no steps) | n/a (no measures) |

So the run span is the only span with CPU attribution on the default and node lanes; steps get it only
under chrome `--breakdown`; measures get it under chrome `--breakdown` and firefox. `--deep` and
`--precise-wall` run the sampler OFF, so no span carries a CPU number on them.

### The sampler's window resets on a cross-process navigation

**[measured]** The V8 sampling profiler restarts in the new renderer process on a cross-process
navigation: `Profiler.stop` returns only the post-navigation process's samples. So the `CpuModel`, the
run bar's `js` slice, the per-span hot list, and the "sampled window" cover **only the run after its
last cross-process navigation**; page CPU work done in a prior renderer is absent from `selfMs` and the
bar. A pre-navigation span can therefore hold zero samples while its own bar shows real
trace-measured JS: the sampled window is the profiler's own `endTime − startTime`, not the run wall.

Probe: a driver module that burns ~150 ms of page CPU on the blank host page, then
`page.goto()` to a different origin (a true renderer swap), reports **10.4 ms** total JS self-time and
a **229 ms** sampled window that is entirely the post-navigation settle -- **zero** samples for the
150 ms loop. A same-origin control (no process swap) loses nothing: `Σ timeDeltas` equals the window to
0.1 ms. This bites only a driver flow that does page work *before* it navigates; the built-in on-ramp
load flow navigates as its first action, so there is no pre-navigation window to lose. It is distinct
from the trace-count re-anchor (`trace/main-thread.ts`, which follows the navigation for counts) and
from the step-wall page-clock reset (`driver.ts`, which is about `performance.now()`, not samples).
Firefox does not have this gap: its Gecko profiler runs for the whole browser lifetime and does not
restart on navigation.

## Per-span hot functions

`query span <label>` shows a per-span hot list on the sampler rungs: the run span reads it from the
CpuModel at query time; a `--breakdown` chrome step/measure span and a firefox measure span carry
stored top-K refs (`SpanHot`, `profile/span-hot.ts`), joined to `CpuModel.functions[]` by id. The
join is `functionIdByNode`, which reproduces the model's rank purely from the raw profile (same
`isRankableFrame` filter, same self-time-desc + frameKey tiebreak), so a per-span sample lands on the
exact function `query cpu` names.

Four constraints are load-bearing (**[measured]**, probe on a forced-layout driver flow + a repeated
`performance.measure`):

- **The hot list is a separate panel on the CPU-sampler SCRIPTING axis, never the bar's `js` slice.**
  The two are different axes: the sampler bills a forced layout to the JS frame that forced it, so on
  a layout-forcing span the list exceeds the bar's `js.ms` by ~1000x, and even a pure-JS loop exceeds
  it. Reconciling the list to `js.ms` is therefore wrong; the invariant is **`Σ per-function selfMs <=
  the span's window wall`**, not `<= js.ms`.
- **Display unit is the SHARE of the span's pooled JS samples**, with `selfMs = samples * interval`
  only as a secondary figure. The panel discloses `pooledSamples` and `occurrences`, because a pooled
  measure's `scriptingMs` sums every occurrence and can dwarf the median-occurrence bar wall the span
  header shows (measured: pooled 20.4 ms JS over 6 occurrences beside a 3.9 ms median bar) -- the
  disclosure is what stops a reader dividing a pooled ms by one iteration.
- **Pooling is MEASURE-only.** A step tallies its single iteration-0 window (already how step windows
  work); a measure label pools across all its occurrences. Pooling a step across iterations would let
  a trivial click step clear the floor on puppeteer-frame samples alone (below), so steps stay
  single-window.
- **Floors, not fabrication.** Below ~10 pooled JS samples the ranked list is suppressed
  (`suppressed: true` + a raise-`--iterations` hint), never a top-N invented from noise; a function
  below ~3 pooled samples is dropped from the list.

**Caveat (pre-existing, inherited, not widened here):** puppeteer's own `page.click` machinery injects
`pptr:evaluate;<method>` frames (`isIntersectingViewport`, `visibleRatio`, ...) whose call-site file
is `puppeteer-core`, not one of wpd's four injection sites in `WPD_EVALUATE_SITES`, so `isToolFrameUrl`
does not drop them and they rank like user code (they already appear in `query cpu`). Negligible on a
heavy step (a handful of samples), but they are the ENTIRE ranked set on a click-only step -- which is
exactly the case the 10-sample suppression floor covers. Widening the tool-frame filter is its own
risky change and is deliberately NOT done for this feature.

## Sourcemap note gating

The note answers "can the package rollup be believed?", which is a **different question** from "did
any sourcemap resolve?". Gating it on `resolved === 0` ("no sourcemap resolved") conflates the two
and lies in the most common case:

```
$ wpd record examples/forces-layout.mjs --bench
• WARNING: no sourcemap resolved ... CPU self-time is attributed to minified bundle names
Sourcemaps: 0/1 resolved ← packages below are minified bundles, not real packages
```

`forces-layout.mjs` is hand-written unbundled ESM. Nothing is minified, and every frame resolves to
`forces-layout.mjs:24`. It has no sourcemap because **it needs none**.

### The trigger needs TWO signals

Worth reading before touching this, because the obvious narrowing is wrong and its wrongness is
silent.

Gating on `CpuModel.unmappedFrames` alone — frames that fell back to an origin bucket — kills the
false positive **and the true positive**: a local frame *always* resolves to a path
(`makeSourceResolver` sets `frame.source` for every served file), so `unmapped: !isLocalPath` can
never fire for a local script. A minified `app.min.mjs` with no map — precisely what `vite build`
emits, since `build.sourcemap` defaults to `false` — is attributed to whatever `package.json` sits
above it and warns about **nothing**. That gap is invisible from the output, because "we know the
file path" and "we know whose code this is" are different facts and one flag cannot carry both.

So the condition is measured twice, at the two places the damage is actually done:

| signal | where | catches |
| --- | --- | --- |
| `SourceMapDiagnostics.unmappedBundles` | `SourceMapResolver.diagnostics()` | a script that **is build output** (minified) whose map did not resolve — local *or* remote |
| `CpuModel.unmappedFrames` | `resolveCallFrame` | a frame with **no determinable owner**, bucketed by origin — remote only |

Neither alone is enough: a local minified bundle has `unmappedFrames === 0` (its path is known), and
an unminified remote script has `unmappedBundles === 0` (yet we still cannot say whose it is). The
note fires on either.

`unmapped` is set in `resolveCallFrame` at the point it falls back to `unmappedOriginBucket`, **not**
inferred afterwards from the package string: `(cdn.example.com)` is unmapped while `(native)` and
`(node)` are not, and telling those apart by pattern breaks on a dotless host (`(localhost)`).

**Known false negative:** `looksMinified` tests for a line over 500 chars, so a *small* minified
bundle whose lines all stay short reads as plain source and does not warn. Real build output is
nowhere near that (bundlers join whole modules onto one line — the repo's own test fixture lands at
1114 chars, and a react-dom bundle is orders beyond), so the gap is narrow and deliberate: the
alternative is guessing, and a warning that cries wolf on every hand-written module is worse than
one that misses a toy bundle.

Four unit tests pin all of it — remote unmapped bundle counts, node builtin does not, minified local
bundle counts, plain local source does not. Keep both directions genuinely covered: **when you
remove a false positive, the test that matters is the one proving the true positive still fires.**
