# The Firefox CPU lane: one gecko pass, honest idle, the 1 ms floor (internal)

> **Developer notes, not user documentation.** Read the [README](../../README.md) to use wpd. This
> file records how the Gecko profiler is configured and what its samples can honestly report, so the
> next person does not "fix" the config into a fake number. Read it before touching
> `browser/launch.ts`'s `MOZ_PROFILER_*` env vars, `profile/gecko-breakdown.ts`, or the Firefox
> sampler interval.

**In this file:** [the sampler contaminates self-time on reflow-heavy work](#the-sampler-contaminates-self-time-on-reflow-heavy-work)
· [idle lives on the CPU axis](#firefox-idle-is-on-the-cpu-axis-not-the-category-axis)
· [the `js,cpu` / 1 ms config](#the-firefox-sampler-config-jscpu-1-ms-and-what-not-to-chase)
· [where the ~150% overhead comes from](#where-the-150-gecko-overhead-comes-from)

**Provenance.** As in [cpu-profiling.md](./cpu-profiling.md): interleaved warmed runs of the probes
named per section, Firefox 152. The overhead-split section is 8 rounds x 20 iterations, interleaved,
of `examples/gecko-overhead.mjs`. Related: [gecko-profile-format.md](./gecko-profile-format.md) (the
raw dump schemas these facts are read out of), [engine-mapping.md](./engine-mapping.md) (what the
Gecko names mean against Blink's), [cpu-profiling.md](./cpu-profiling.md) (the Chrome sampler
physics this lane is measured against).

## The sampler contaminates self-time on reflow-heavy work

The gecko pass collects markers *and* samples together — structurally the thing
[cpu-profiling.md](./cpu-profiling.md#why-the-sampler-never-rides-a-stack-trace) warns against,
since `profiler_capture_backtrace()` fires on every invalidation. It cannot be separated: the Gecko
profiler is started via `MOZ_PROFILER_STARTUP*` env vars for the whole browser lifetime, and the `js`
feature that yields JS stacks for cause chains is the same feature that yields samples.

**[measured]** and it does contaminate, the same shape as Chrome's `.stack` +21%. A workload sweep,
Firefox 152 / Chrome 150, 5 reps each bench, comparing `run()` self-time (chrome's default no-trace
sampler is the clean reference):

| workload | forced flushes | firefox `selfMs` | chrome `selfMs` | FF / CR |
| --- | --- | --- | --- | --- |
| pure JS (no reflow) | 0 | 29.2 | 35.1 | **0.83x** |
| forces-layout, cold (iter 1) | ~40 | 11.94 | 7.96 | 1.50x |
| forces-layout, warm (iter 15) | ~40 / iter | 31.5 | 12.3 | 2.56x |
| read-after-write thrash | ~3000 / iter | 602.9 | 195.5 | **3.08x** |

Read it as: **pure JS crosses clean** (firefox 0.83x chrome, a SpiderMonkey-vs-V8 speed offset), so
the sampler is not broadly inflating. The moment JS forces layout, firefox self-time runs 1.5-3x
chrome's and the excess **scales with forced-flush count** — the signature of a per-marker cost, not a
per-sample one, exactly like the ~150% wall tax below. It is billed to the forcing JS frame, so it
raises `run()`'s self-time directly.

**The excess is real main-thread CPU, not descheduling.** Per-sample `threadCPUDelta` (the `cpu`
feature) tracks the sample's wall-delta within **4%** on the active (non-idle) samples of the
reflow-heavy dumps, so the samples the converter bills to `selfMs` are cycles the content thread
actually burned — the stack captures — not a stalled clock inflated by a loaded host.

So Firefox `selfMs` on browser lanes is JS + real synchronous reflow (the honest "delete this line"
signal, same as chrome) **plus** this per-reflow capture tax, and it cannot be described as clean on
reflow-heavy work. It is comparable to chrome's only at the pure-JS / `--target node` end, or when one
large cold reflow swamps the per-flush tax (the iter-1 forces-layout row, 1.5x). Firefox has no
sampler-free counterpart to subtract it (the `js` feature is the sole source of samples AND cause
stacks AND the marker captures), so the contamination is structural, not a config to turn off. The
cross-engine trust boundary this sets is in
[engine-mapping.md](./engine-mapping.md#what-is-actually-comparable-across-engines).

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
`(idle)` (honest `jsSelfMs`), and `computeGeckoCpuBreakdown` tiles the window
`js · style · layout · browser · gc · idle`, with style/layout from each sample's nearest-to-leaf
Layout-category frame. A dump without the CPU signal (an older recording, or js-only) carries no
idle signal, so no bar is emitted rather than a fabricated one. `cpuallthreads` is unnecessary
(`js,cpu` reproduces the idle result, sampling only registered threads) and `stackwalk` adds zero
signal. Paint stays off the bar: it is off-main-thread compositor work (a side track), never summed.

### The idle cutoff (`IDLE_CPU_DELTA_EPSILON_US` = 50 µs)

A sample counts as idle when its `threadCPUDelta` is below 50 µs of CPU: the thread consumed
~no CPU since the previous sample while wall-time advanced, i.e. it was descheduled. **[measured,
Firefox 152, macOS, the `awaits-only` 470 ms pure-wait probe]** the cutoff sits between two endpoints:
eps 0 reads **94.5-95.7% idle**, eps 100 µs reads **99.1% idle**. 50 µs is the conservative middle,
high enough to tolerate the small mutex/IO CPU a sleeping thread can still show (Firefox Bug 1689325)
without fabricating idle, low enough that it never swallows a busy sample: real work reads ~one full
interval (~1000 µs) of CPU, about **20x** the cutoff, so the busy/idle split is not sensitive to the
exact value. A "variable CPU cycles" unit (no time) is compared to the same number directly, where
only ~0 cycles reads idle -- the sound direction.

## The Firefox sampler config: `js,cpu`, 1 ms, and what not to chase

**[measured]** `examples/cpu-busywork.mjs --bench --target firefox`, interleaved arms, RAW dumps.

- **The 1 ms floor is a measured choice, not the OS limit.** Requesting 0.5 ms *is* delivered on
  macOS — achieved **0.50 ms** median (0.499-0.50 raw over 5 runs), so the `usleep()` floor does
  not hold — but it is declined: it doubles samples for resolution wpd does not use (function lists +
  self-% are interval-stable, [cpu-profiling.md](./cpu-profiling.md#the-sampler-interval-why-200us)),
  and it *worsens* the two things that matter — jsSelfMs-vs-bench-wall reconciliation
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
- **[measured] The shutdown dump is complete when `browser.close()` resolves.** Puppeteer's close
  waits for the Firefox process to exit, and `MOZ_PROFILER_SHUTDOWN` writes the dump during that
  shutdown, so by the time `waitForGeckoDump` runs the file already exists at full size (measured
  across 7 rounds and two ring sizes: poll-to-first-exists 0 ms, never grew after close 0/7). The
  growth-detection stability check (`GECKO_DUMP_STABLE_READS`) and the 15 s timeout stay only to
  guard a slow-disk lag on a very large dump landing after the first stat; the poll cadence is tight
  (`GECKO_DUMP_POLL_MS` 20 ms) so stability confirms in a few reads, not a fixed ~750 ms floor.

## Where the ~150% gecko overhead comes from

**[measured]** The gecko pass costs **~140% wall** over a plain Firefox launch on a reflow-heavy
window, where Chrome's sampler costs ~4-7% on the same work. That cost is **workload-weighted, not a
standing sampler tax**: it is the per-reflow marker capture, and it collapses to a few percent when
the page does not reflow.

Probe: `examples/gecko-overhead.mjs`, one page-clock window over a MIXED workload (a ~7 ms integer
loop plus a read-after-write thrash, ~550 forced reflows) and a PURE-JS workload (the same integer
loop, zero layout), each against its own plain-Firefox baseline. Firefox clamps `performance.now()`
to 1 ms, so the pooled MEAN over 160 samples is the small-effect read and the median the
cross-check. `Δ mean` vs the matching baseline:

| cell (features, interval, filter, entries) | workload | Δ vs plain Firefox |
| --- | --- | --- |
| `js,cpu` 1 ms — the shipped config | mixed (~550 reflows) | **+141%** |
| `js,cpu` 4 ms | mixed | +128% |
| `js,cpu` 16 ms | mixed | +123% |
| `js,cpu` 50 ms | mixed | +119% |
| `js,cpu` 1 ms, `FILTERS=GeckoMain` | mixed | +135% |
| `js,cpu` 1 ms, `ENTRIES=1M` | mixed | +135% |
| `js` 1 ms (no `cpu`) | mixed | +135% |
| `js,cpu` 1 ms — the shipped config | pure JS (0 reflows) | **+5%** |

Reading it, and reconciling with the tighter numbers above:

- **It is per-reflow, not per-sample (interval-independent).** Sweeping the periodic interval 50x
  (1 ms -> 50 ms) drops overhead only ~141% -> ~119%. A per-periodic-sample cost would fall ~50x; it
  barely moves. The reason: each synchronous reflow emits a `Reflow (sync)`/`Styles` marker carrying a
  captured JS cause stack (`data.stack`, a StackMarker,
  [gecko-profile-format.md](./gecko-profile-format.md#reflowstyles-markers---layoutstyle-blame-see-the-semantics-warning)),
  and those markers fire on the reflow, not on the sampler tick. So the ~119% floor rides on the reflow
  count, and the ~20% the interval reclaims is the periodic sampler's own slice at 1 ms. This is the
  Gecko analog of Chrome's `.stack` tax ([cpu-profiling.md](./cpu-profiling.md#why-the-sampler-never-rides-a-stack-trace)):
  a stack capture on every layout, billed to the same thread.
- **It collapses on pure JS.** The same shipped config over the zero-reflow window costs **~5%** — the
  sampler's own wall, no markers to capture. That +5% baseline-delta is the same order as the
  **~4%** jsSelfMs-vs-bench-wall reconciliation residual measured above; the two are different axes
  (a delta vs an uninstrumented baseline here, a within-run sum-vs-wall residual there) that agree the
  periodic sampler on non-reflow work is small. The +141% is what a page full of forced reflows adds
  on top, so the headline scales with reflow count: a low-reflow interaction pays far less than this
  ~550-reflow probe.
- **`cpu` is ~free here.** `js` alone (+135%) and `js,cpu` (+141%) are within noise, confirming the
  `cpu` feature's ~1% cost. The overhead is driven by `js` — which wpd cannot drop (it is the source of
  UserTiming windowing marks, cause-stack blame, AND the only samples), and `js` is exactly what makes
  every reflow marker capture a stack.

**No cheap lever, verified.** Two configs that look like speed levers buy nothing and one is a
correctness hazard:

- **Thread filter buys no wall and loses no signal.** `FILTERS=GeckoMain` (+135%) is within noise of
  the shipped +141%: the marker cost is on the content main thread itself, so sampling fewer sibling
  threads does not touch it. The probe's signal-loss check confirms the filtered dump still carries
  everything wpd reads off the content thread — `threadCPUDelta` 100% populated, ~26k Reflow/Styles
  markers, `parseGecko` accepts it (wpd already reads exactly one content thread in `profile/gecko.ts`,
  so filtering to `GeckoMain` drops only threads wpd ignores). It stays unset because the wall is
  identical and the extra threads' samples are harmless.
- **`ENTRIES=1M` buys no wall (+135%) and would silently drop the window's earliest samples** (above).
  The dump is the same ~51 MB either way, confirming size scales with samples used, not the ring
  ceiling.

So the ~140% is the honest floor of the Firefox lane on rendering-heavy work, and Firefox has no
sampler-free counterpart to buy it back (the gecko profiler is a whole-lifetime startup feature).
Chrome offers none either: neither engine has a sampler-free wall, because the sampled wall is
directional and the attribution is the product. Directional and machine-dependent — the ordering and
the per-reflow-vs-per-sample split are the load-bearing part, not the exact percent. Refresh with
`npm run build && node examples/gecko-overhead.mjs`.
