# CPU profiling: capture modes, contamination, and what self-time means (internal)

> **Developer notes, not user documentation.** Read the [README](../../README.md) to use wpd. This
> file records why the capture modes are shaped the way they are, with the measurements behind it, so
> the next person does not "optimise" the structure into a wrong number.

**In this file:** [what self-time includes](#what-self-time-actually-includes)
· [the capture modes](#the-capture-modes)
· [the sampler opens at the run mark](#the-sampler-opens-at-the-run-mark-not-before-prepare)
· [never ride a `.stack` trace](#why-the-sampler-never-rides-a-stack-trace)
· [trace durations vs CDP](#layoutmsstylemspaintms-are-trace-durations-and-cdp-would-be-no-finer)
· [the interval: why 200us](#the-sampler-interval-why-200us)
· [sub-frame resolution](#sub-frame-cpu-work-is-measurable-on-both-engines-off-the-frame-floor-axis)

Split out: [firefox-cpu.md](./firefox-cpu.md) (the Gecko sampler lane: shared pass, honest idle,
the 1 ms floor), [cpu-attribution.md](./cpu-attribution.md) (which spans get samples, hot
functions, sourcemap trust). Related: [engine-mapping.md](./engine-mapping.md) (Gecko <-> Blink
names and semantics), [gecko-profile-format.md](./gecko-profile-format.md) (raw dump schemas).

**Provenance.** Capture-mode numbers are 5 interleaved runs per arm, after a discarded warmup, of
`examples/forces-layout.mjs --bench` on chrome 150 / firefox 152; interval numbers are 3 runs per arm
of `examples/cpu-busywork.mjs --target node`. First-run numbers are cold-start outliers by a wide
margin (a single un-warmed run reads 18ms against a 7ms median, enough to "prove" the wrong
conclusion): **always warm up and interleave** before believing a capture-mode A/B.

## What self-time actually includes

**[measured]** The headline fact, and it is not what "CPU profile" suggests.

On the browser lanes, `selfMs` is **JS plus the synchronous engine work that JS triggered** — not
pure JS. The default capture mode (sampler, tracing off) on the forced-layout probe:

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
[blame-semantics.md](./blame-semantics.md#forced-layout-blame-differs-by-engine)).

But it constrains what may be claimed:

- **`--target node`**: no DOM, so self-time really is pure JS cost. The SSR / `renderToString`
  framing is accurate here and only here.
- **browser lanes** (`--bench`, driver): self-time is JS + synchronous engine work. Do not describe
  it as "pure JS cost".

## The capture modes

Every invocation is exactly ONE capture pass: one browser launch, one run of the flow, one recording.
A capture mode picks WHAT that pass captures, never how many passes run. `captureFor()` in
`src/record/capture.ts` is the authority.

```
chrome default:        [sampler]                     four-slice CPU bar; no rendering counts
chrome --breakdown:    [light-trace + trace samples]  seven-slice reconciling bar + exact counts
chrome --deep:         [full trace, sampler OFF]     forced-layout blame + exact counts, no bar
chrome --precise-wall: [no trace, no sampler]        pristine benchmark wall, nothing else
firefox:               [gecko]                        one pass; every capture mode is a reporting tier over it
node:                  [node-cpu]                     in-process V8, four-slice bar (engine slice "native")
```

- **default**: the CPU sampler alone, no DevTools trace, for the cleanest wall (~1%). Reports the
  four-slice CPU bar (`js · browser · gc · idle`) and no rendering counts, so
  layout/style/paint/forced are `Measured` null, never 0.
- **--breakdown**: ONE fused pass: a light trace (the shipped categories MINUS
  `disabled-by-default-devtools.timeline.stack` and MINUS `invalidationTracking`, plus gc events, PLUS
  `disabled-by-default-v8.cpu_profiler`). The CPU samples come from that `v8.cpu_profiler` ProfileChunk
  stream, **not** the CDP `Profiler.start/stop` sampler (no CDP profiler runs in this capture mode). The stream
  shares the trace's `base::TimeTicks` clock, so the seven-slice
  `js · style · layout · paint · gc · other · idle` bar reconciles, and the trace carries exact
  layout/style/paint counts. The stream is **continuous across a cross-document navigation** (the CDP
  sampler resets per navigation), so a navigating driver step or an early measure occurrence keeps its
  CPU attribution -- the gap the CDP sampler leaves is closed here. **[measured]** the fused pass leaves
  self-time clean (**+0-1%** vs the sampler-only baseline, no invented functions) and costs **~2-5%**
  wall over `--precise-wall` (measured cpu-busywork +4.0%, fixed-js-work +2.4%); dropping `.stack` is
  what removes the +21% contamination below (`v8.cpu_profiler` is not `.stack`: same order as the light
  trace's own cost). The stream samples at a **fixed ~150us** it sets itself, read back from the chunk
  deltas into `meta.cpuIntervalUs`/`CpuModel.sampleIntervalUs` (never the 200us default constant, which
  does not describe this capture mode); it is not settable up without a CDP profiler, and ~150us is inside the
  interval-stable band, so the reported percentages do not move. Being one pass it runs every iteration,
  so counts total across `--iterations`; forced counts and blame need `.stack`, so this capture mode reports
  them `null`, never 0.
- **--deep**: ONE full trace (`.stack` + `invalidationTracking`) with the sampler OFF: forced-layout
  blame (read-site), dirtied-by writes, the thrash detector, invalidation rollup, exact counts and
  long tasks. No CPU model and no reconciling bar. Slice durations are suppressed (`.stack` inflates
  them, style up to +38% below); the span's wall (window width) is still reported.
- **--precise-wall**: the default capture mode minus the sampler: a pristine benchmark wall, no sampler
  perturbation, no counts, no CPU model.
- **gecko**: firefox only; one Gecko-profiler run yields CPU samples *and* layout/style markers. It
  is the firefox lane in every capture mode (the profiler is a whole-browser-lifetime startup feature), so
  the capture modes are reporting tiers over this one capture. `--deep` adds a dirtied-by write report from
  Gecko's native cause stacks; `meta.passes` is `gecko` or `gecko-deep`. See
  [firefox-cpu.md](./firefox-cpu.md).
- **node**: `--target node`; the in-process V8 sampler (`runtime/node.ts`), CPU-only, four-slice bar
  with the engine slice labeled `native`.

CPU profiling is **on by default** wherever a capture mode samples (chrome default and `--breakdown`, firefox,
node) and costs no extra pass. The sampler-free capture modes are chrome's `--precise-wall` and `--deep`;
node and firefox have none, because node would measure nothing without the sampler and firefox
without the gecko pass reports every rendering count as 0.

### The sampler opens at the run mark, not before prepare

**[measured]** The V8 CPU model is built from the WHOLE returned profile, never sliced to the run
window: there is no trace clock in the default capture mode to slice it by, so whatever the sampler recorded
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
`prepare()` that navigates is simply excluded, and a `run()` that navigates behaves as before -- on the
default capture mode the CDP profiler resets in the new process, so page CPU work before the navigation is
absent from `scriptingMs`. `--breakdown` does not have this loss: it sources samples from the trace's
`v8.cpu_profiler` stream, which is continuous across the navigation
([cpu-attribution.md](./cpu-attribution.md#the-cdp-samplers-window-resets-on-a-cross-process-navigation-the-default-capture-mode---breakdown-does-not)).
There the trace-sourced profile is instead windowed to the run onward (`windowTraceCpuProfile`, since
the trace runs before `prepare()` in driver mode), which excludes `prepare()`/warmup by timestamp
rather than by when the sampler opened.

### Why the sampler never rides a `.stack` trace

**[measured]** Sampling is cheap; that is not why the sampler needs a trace it can avoid.
**The `.stack` category contaminating the sampler is.** The load-bearing property of any pass the
sampler rides is that `.stack` is off it: the default capture mode has no trace at all, and the `--breakdown`
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
the capture mode it rides: **perIteration +10% median and ~3x the variance** at a 50us interval, most of
which the 200us default below buys back. The CPU model itself is intact (+4%, overlapping ranges,
same function count).

That trade respects the existing trust hierarchy — wall is declared *directional*, CPU self-time is
declared *real* — and systematic inflation cancels in `diff`, where both sides carry it. So the
sampling capture modes (default, `--breakdown`) are not pristine on wall, which is what `--precise-wall` is
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

## Sub-frame CPU work IS measurable on both engines, off the frame-floor axis

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
