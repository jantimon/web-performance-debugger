# CPU attribution: which spans get samples, hot functions, sourcemap trust (internal)

> **Developer notes, not user documentation.** Read the [README](../../README.md) to use wpd. This
> file records where CPU samples can honestly land — which span kinds, across which navigations —
> and when the package rollup they feed can be believed. Read it before touching
> `profile/span-hot.ts`, `trace/profile-chunks.ts`, or the sourcemap warning.

**In this file:** [the span-kind coverage matrix](#which-spans-get-cpu-attribution)
· [navigation resets the CDP sampler; `--breakdown` is continuous](#the-cdp-samplers-window-resets-on-a-cross-process-navigation-the-default-rung---breakdown-does-not)
· [per-span hot functions](#per-span-hot-functions)
· [when the package rollup can be believed](#sourcemap-note-gating)

**Provenance.** As in [cpu-profiling.md](./cpu-profiling.md), which also holds the sampler physics
(rung ladder, contamination, interval) these attribution rules sit on.

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

## The CDP sampler's window resets on a cross-process navigation (the default rung); `--breakdown` does not

**[measured]** The V8 CDP sampling profiler restarts in the new renderer process on a cross-process
navigation: `Profiler.stop` returns only the post-navigation process's samples. So on the **default
rung** (the only rung that runs the CDP sampler and can navigate: `--url` boots, driver flows) the
`CpuModel`, the run bar's `js` slice, and the "sampled window" cover **only the run after its last
cross-process navigation**; page CPU work done in a prior renderer is absent from `selfMs`.

Probe: a driver module that burns ~150 ms of page CPU on the blank host page, then
`page.goto()` to a different origin (a true renderer swap), reports **10.4 ms** total JS self-time and
a **229 ms** sampled window that is entirely the post-navigation settle -- **zero** samples for the
150 ms loop. A same-origin control (no process swap) loses nothing: `Σ timeDeltas` equals the window to
0.1 ms. It is distinct from the trace-count re-anchor (`trace/main-thread.ts`, which follows the
navigation for counts) and from the step-wall page-clock reset (`driver.ts`, which is about
`performance.now()`, not samples).

**`--breakdown` closes this gap**: it sources samples from the trace's `v8.cpu_profiler` stream, not
the CDP sampler, and that stream is continuous across the navigation (probe: 3868 samples spanning two
documents vs the CDP sampler's 689, post-nav only). `trace/profile-chunks.ts` merges the per-process
ProfileChunk streams into one `RawCpuProfile` (each process restarts its node-id space at 1, so the
merge renumbers node ids into disjoint ranges, inverts `parent` -> `children`, and stamps each sample
with its absolute trace-clock timestamp). So a pre-navigation step or an early measure occurrence keeps
its per-span hot list and js-by-package split, where the CDP sampler leaves them empty (the
`samplerCoverageGap` note, still emitted on any window the stream genuinely could not reach, e.g. a
browser build that emits no chunks). Firefox does not have the gap either: its Gecko profiler runs for
the whole browser lifetime and does not restart on navigation.

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
