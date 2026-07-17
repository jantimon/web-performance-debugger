# CPU profiling: passes, contamination, and what self-time means (internal)

> **Developer notes, not user documentation.** Read the [README](../../README.md) to use wpd. This
> file records why the pass plan is shaped the way it is, with the measurements behind it, so the
> next person does not "optimise" the structure back into a wrong number.

Related: [engine-mapping.md](./engine-mapping.md) (Gecko <-> Blink names and semantics),
[gecko-profile-format.md](./gecko-profile-format.md) (raw dump schemas).

**Provenance.** Pass-structure numbers are 5 interleaved runs per arm, after a discarded warmup, of
`examples/forces-layout.mjs --bench` on chrome 150 / firefox 152; interval numbers are 3 runs per arm
of `examples/cpu-busywork.mjs --target node`. First-run numbers are cold-start outliers by a wide
margin (a single un-warmed run showed 18ms against a 7ms median, and would have "proven" the wrong
conclusion) — **always warm up and interleave** before believing a pass-structure A/B.

## What self-time actually includes

**[measured]** The headline fact, and it is not what "CPU profile" suggests.

On the browser lanes, `selfMs` is **JS plus the synchronous engine work that JS triggered** — not
pure JS. The isolated CPU pass (tracing off, i.e. what ships today) on the forced-layout probe:

```
8.41 ms   fn=run    examples/forces-layout.mjs:24
0.20 ms   fn=elementFromPoint   (native)
```

The probe's actual JavaScript is a couple dozen property reads — microseconds. But the trace pass
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

## The pass plan

```
chrome:  [timing+sampler] [trace]
firefox: [timing]          [gecko]
node:    [node-cpu]
```

- **timing** — `categories: null`, tracing off. Clean wall/per-iteration times + CDP counters, and
  **the CPU sampler rides here** (see below). `--no-cpu-profile` takes the sampler back off.
- **trace** — full DevTools timeline incl. `invalidationTracking`. Counts, events, attribution.
  Durations here are distorted by instrumentation **by design**; timing comes from the timing pass.
  **The sampler must never run in this pass** (see below).
- **gecko** — firefox only; one Gecko-profiler run yields CPU samples *and* layout/style markers.

CPU profiling is **on by default on every target** and costs no extra pass. It was `--cpu-profile`
(opt-in, third pass) until 0.5.0; the flag was only ever meaningful on chrome — node forced it on,
and firefox without it silently reported every rendering count as 0.

`--no-isolate` collapses to the single trace pass, which the sampler cannot ride, so that
combination yields no CPU model and says so in `meta.notes`.

### Why the CPU pass is separate: tracing contaminates sampling

**[measured]** The comment historically said "CPU sampling is heavy, so it gets its own isolated
pass". That reasoning is **wrong** and the parenthetical ("tracing stays off in it") was the real
load-bearing part. Sampling is not the problem. **Tracing contaminating the sampler is.**

Folding the sampler into the trace pass:

| sampler runs in | passes | CPU self ms | CPU fns | perIteration ms |
| --- | --- | --- | --- | --- |
| own pass (pre-0.5.0) | 3 | **8.67** (8.2–11.4) | 7 | **8.3** (8.0–8.7) |
| **trace pass** (never do this) | 2 | **10.4** (10.0–11.2) | **10** | 8.3 |
| timing pass (**shipped**) | 2 | 8.99 (8.3–13.3) | 7 | 9.1 (8.3–13.4) |

Trace-folding inflates CPU self-time **+21% with non-overlapping ranges** and invents functions.
The mechanism is our own trace config: `disabled-by-default-devtools.timeline.stack` makes Blink
capture a JS stack on every Layout/UpdateLayoutTree — *while JS is on the stack* — so the sampler
attributes trace-emission cost to the JS function that forced the layout. It is **not uniform**
(top fn +4%, total +21%), so `--by package` proportions shift too.

The insidious part: this lands on the **same frame** as the real forced-layout time described
above. From inside the folded pass the two are indistinguishable. One is production cost; the other
is measurement apparatus that exists only because we asked for it. Reporting 10.4ms for a line that
costs 8.4ms in production is precisely the fake number this project refuses elsewhere.

Counts are never at risk: `layoutCount`/`styleCount`/`forcedLayoutCount` were byte-identical
(22/23/43) across all 20 runs of the A/B.

### Do not "correct" the contamination arithmetically

It is tempting: the trace pass knows exactly which forced events fired on which source line, so a
per-line subtraction (~1.7ms / 43 events ~= 40us each) looks derivable. Don't. That constant is
**fitted, not measured** — it varies with stack depth — and it would inject a modeled correction
into the one signal the trust table calls "real: trustworthy in aggregate". Folding into the
**timing** pass removes the error instead of modelling it. Prefer the design where the number is
measured.

### Why it rides the timing pass (shipped in 0.5.0)

**[measured]** The cpu spec and the timing spec were *the same pass* (`categories: null`), differing
only by the sampler. So the third pass bought isolation from the **timing** pass, which was never
what mattered — isolation from **tracing** was, and the timing pass has that for free.

Riding there: 2 passes, **record wall 2.48s vs 3.68s (-33%)**, CPU model intact (+4%, overlapping
ranges, same function count). The cost lands on wall instead: **perIteration +10% median and ~3x
the variance** at the old 50us interval — most of which the 200us default below buys back.

That trade respects the existing trust hierarchy — wall is already declared *directional*, CPU
self-time is declared *real* — and systematic inflation cancels in `diff`, where both sides carry
it. The timing pass is no longer pristine, which is what `--no-cpu-profile` is for: clean-wall and
`--iterations` benchmarking work.

### The sampler interval: why 200us

**[measured]** The default was `50us` — **20x more aggressive than V8's own 1000us** — and that is
where most of the timing-fold's wall cost came from.

Tuned against `examples/cpu-busywork.mjs` (**~2.2 seconds** of real JS), *not* the layout probe. A
layout probe is the wrong workload for tuning a JS sampler: it has ~8ms of JS, so any coarsening
starves it and looks catastrophic. Measuring on the probe first suggested 200us "collapsed"
resolution from 7 functions to 3; on a real JS workload that effect does not exist.

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

## Firefox: samples and markers share a pass, unavoidably

The gecko pass collects markers *and* samples together — structurally the thing warned against
above, since `profiler_capture_backtrace()` fires on every invalidation. It cannot be separated:
the Gecko profiler is started via `MOZ_PROFILER_STARTUP*` env vars for the whole browser lifetime,
and the `js` feature that yields JS stacks for cause chains is the same feature that yields
samples. So Firefox's CPU model may carry contamination of the same shape as Chrome's trace-fold.

**This has not been measured.** It should be, before Firefox CPU numbers are described as clean.
The one data point that argues against a large effect: firefox `run()` = 8.79ms vs chrome's
uncontaminated 8.41ms, a 5% gap — but that is one probe and the two engines differ for other
reasons too.

## Sourcemap note gating (fixed in 0.5.0)

The sourcemap note is gated on a **CPU model existing**, not merely on
`maps.diagnostics().scripts > 0`. It used to fire whenever any script was seen, so a run with no CPU
profile still printed `WARNING: no sourcemap resolved ... so CPU self-time is attributed to minified
bundle names` — about a profile that was never taken. Trace stacks resolve through the same resolver
but are reported by `blame`, which this note does not describe.
