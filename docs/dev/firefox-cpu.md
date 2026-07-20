# The Firefox CPU lane: one gecko pass, honest idle, the 1 ms floor (internal)

> **Developer notes, not user documentation.** Read the [README](../../README.md) to use wpd. This
> file records how the Gecko profiler is configured and what its samples can honestly report, so the
> next person does not "fix" the config into a fake number. Read it before touching
> `browser/launch.ts`'s `MOZ_PROFILER_*` env vars, `profile/gecko-breakdown.ts`, or the Firefox
> sampler interval.

**In this file:** [samples and markers share one pass](#samples-and-markers-share-a-pass-unavoidably)
· [idle lives on the CPU axis](#firefox-idle-is-on-the-cpu-axis-not-the-category-axis)
· [the `js,cpu` / 1 ms config](#the-firefox-sampler-config-jscpu-1-ms-and-what-not-to-chase)

**Provenance.** As in [cpu-profiling.md](./cpu-profiling.md): interleaved warmed runs of the probes
named per section, Firefox 152. Related: [gecko-profile-format.md](./gecko-profile-format.md) (the
raw dump schemas these facts are read out of), [engine-mapping.md](./engine-mapping.md) (what the
Gecko names mean against Blink's), [cpu-profiling.md](./cpu-profiling.md) (the Chrome sampler
physics this lane is measured against).

## Samples and markers share a pass, unavoidably

The gecko pass collects markers *and* samples together — structurally the thing
[cpu-profiling.md](./cpu-profiling.md#why-the-sampler-never-rides-a-stack-trace) warns against,
since `profiler_capture_backtrace()` fires on every invalidation. It cannot be separated:
the Gecko profiler is started via `MOZ_PROFILER_STARTUP*` env vars for the whole browser lifetime,
and the `js` feature that yields JS stacks for cause chains is the same feature that yields
samples. So Firefox's CPU model may carry contamination of the same shape as Chrome's `.stack`.

**This has not been measured.** It should be, before Firefox CPU numbers are described as clean.
The one data point that argues against a large effect: firefox `run()` = 8.79ms vs chrome's
uncontaminated 8.41ms, a 5% gap — but that is one probe and the two engines differ for other
reasons too.

## Firefox idle is on the CPU axis, not the category axis

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

## The Firefox sampler config: `js,cpu`, 1 ms, and what not to chase

**[measured]** `examples/cpu-busywork.mjs --bench --target firefox`, interleaved arms, RAW dumps.

- **The 1 ms floor is a measured choice, not the OS limit.** Requesting 0.5 ms *is* delivered on
  macOS — achieved **0.50 ms** median (0.499-0.50 raw over 5 runs), so the `usleep()` floor does
  not hold — but it is declined: it doubles samples for resolution wpd does not use (function lists +
  self-% are interval-stable, [cpu-profiling.md](./cpu-profiling.md#the-sampler-interval-why-200us)),
  and it *worsens* the two things that matter — scriptingMs-vs-bench-wall reconciliation
  **+4%->+7%**, dump size **+1.5 MB**, with no fidelity gain. Sub-frame fidelity comes from
  `--iterations` + measure-spans instead.
- **Profiler self-overhead is 0.03-0.13% on the category axis — nothing to subtract.** wpd's dumps
  are unsymbolicated, so sample leaves are raw JIT addresses with no category and the `Profiler`
  category survives only on a handful of pseudo-frames. The sampler's real cost shows up as wall
  (~4% in reconciliation), not as a category slice, so `selfMs` needs no overhead correction.
- **ENTRIES is not a dump-size lever.** The 16M-entry ring is a ~128 MB ceiling never approached;
  size scales with samples *used* (threads x whole-browser-lifetime x features: `cpu` +0.5 MB,
  `stackwalk` +0.7 MB), so a dump is ~15-23 MB regardless of workload. Do NOT shrink it by lowering
  ENTRIES: undersizing silently overwrites (drops) the window's *earliest* samples. `stackwalk`
  stays off (zero signal on shallow JIT stacks, +0.7 MB).
