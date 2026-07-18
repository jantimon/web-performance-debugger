# What each rendering count actually counts

Read this before adding a name to `trace/classify.ts`, before gating a count in `diff.ts` /
`assert.ts`, or before calling any count "exact".

Everything below is **[measured]** on headless Chrome with purpose-built probes: N widely-spaced
absolutely-positioned divs whose `background-color` changes, with setup done during warmup so it
falls outside the measured window. Layout/style work is held constant; only paint work varies.

## The rule

**A count may be gated only if it is reproducible on unchanged code.** Neither "it is a count" nor
"it comes from CDP" is a substitute:

- `forcedLayoutCount` is trace-derived, not CDP, and is bit-identical across runs. It gates.
- A count summed across raster worker threads swings 3->39 on identical work. It cannot gate,
  whatever it is named.

## Forced counts are a subset of style + layout, not an addend

`buildSummary` bills a forced event to `forcedLayoutCount`/`forcedLayoutMs` AND to the plain
layout/style total in the same pass (`summarize.ts`: the `event.forced` branch increments the forced
counters, then the `layout`/`style` case increments `traceLayoutCount`/`traceStyleCount`; CDP's
`LayoutCount` likewise counts every layout, forced included). So `forcedLayout*` is a **strict subset
of `styleMs + layoutMs`** and the layout/style counts: **never sum forced onto style + layout** — that
double-counts the forced work. The field spans forced **style recalc and forced layout both**, not
layout alone (`event.forced` is set on layout AND style events): the name says layout, the coverage
is both.

## Layout and style counts match the CDP counters 1:1

**[measured]** Trace-derived layout/style counts equal Blink's CDP `getMetrics` counter deltas
exactly, per window, on every workload measured — Blink emits **one trace event per counter
increment**:

    trace `Layout` count           == LayoutCount        (unconditionally)
    trace `UpdateLayoutTree` count == RecalcStyleCount    (excluding ParseAuthorStyleSheet)

`Layout` matches `LayoutCount` 1:1 with zero variance. `UpdateLayoutTree` matches `RecalcStyleCount`
1:1 **only when `ParseAuthorStyleSheet` is excluded** from the style count: that event is a
stylesheet *parse*, not a recalc. It fires only when new author CSS is parsed inside the window (an
injected/loaded `<link rel=stylesheet>`, i.e. a lazy-loaded CSS chunk), and Blink logs it **without**
incrementing `RecalcStyleCount`. Inline `<style>`, `CSSStyleSheet.insertRule`, and DOM/class
mutations never emit it, so on the common interaction (mutate DOM -> recalc -> layout -> paint) trace
and CDP are bit-identical.

The shipped `styleCount` is CDP `RecalcStyleCount` (the merge prefers it), which Blink increments
without ever counting the parse, so it is already parse-free with no filtering needed.
`ParseAuthorStyleSheet`'s time is real main-thread style work, so `taxonomy.ts` keeps it mapped to the
`style` slice (the breakdown bar bills it). The exclusion matters for a *trace-derived* count only:
summing every `style` event gives recalc + parses, so the trace fallback (used when a CDP delta is
absent, e.g. per-step summaries and `--no-isolate`) sums `UpdateLayoutTree` alone — `summarize` skips
`STYLE_PARSE_NAMES` — to match `RecalcStyleCount`.

**No-op mutations** (a write that sets the same value) increment **neither** the counters nor the
events — both correctly skip them.

This is the exact trust tier, not "close enough": the single divergence between a raw trace-`style`
sum and the CDP counter is name-identifiable and deterministic (one event name), not statistical
noise — and the shipped CDP-preferred count never sees it.

## `getMetrics` is top-process-scoped; the trace is browser-wide

**[measured]** `getMetrics` aggregates only the render process of the target it is called on. The top
page's counters count the **top process** — same-origin (same-process) iframes are inside it, since
they share that render process. A `page.tracing` trace, by contrast, captures **every** renderer
process. So a cross-origin **out-of-process iframe** (OOPIF), which runs in its own render process,
has its layout/style work in the trace (on its own `pid`) but **never** in the top page's CDP
counters.

Measured under `--site-per-process`, a top page doing 6 counted flushes with an OOPIF doing 12:

| source | scope | LayoutCount |
| --- | --- | --- |
| `getMetrics`, top target | top process only | 6 |
| `getMetrics`, OOPIF target | child process only | 12 |
| trace `Layout`, all pids | every renderer process | 18 |
| trace `Layout`, top pid only | top main thread | 6 |

The all-pids trace sum is 18 = 6 + 12; filtering the trace to the top pid reproduces the top
`getMetrics` exactly (6 = 6). The frame boundary alone does not split the count (same-origin iframes
sit inside both sides); only the **process** boundary does. wpd's merge prefers CDP counts, so today's layout/style counts are
**top-process-scoped**, and the breakdown bar filters to one main thread and shares that scope — count
and bar agree.

## `Paint` is exact, and it is per-chunk

| dirtied regions | 0 | 1 | 2 | 5 | 10 | 20 | 40 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `Paint` | 0,0,0,0,0 | 2,2,2,2,2 | 3,3,3 | 6,6,6 | 11,11,11 | 21 x5 | 41,41,41 |
| `RasterTask` | 33-38 | 27-34 | 10-33 | 23-34 | 26-32 | 29-34 | 14-34 |

`Paint` is **exactly N+1, with zero variance over 40 runs**. `will-change: transform` (own
compositor layer) does not move it: 2 vs 2 at N=1, 21 vs 21 at N=20. It counts **dirtied paint
chunks, not layers and not frames** -- all 21 `Paint` events at N=20 span 0.056 ms with no `Commit`
interleaved, i.e. they are one frame.

So `paintCount` is in the same trust tier as the CDP layout/style counters, and `assert
--max-paints` / `diff` gate it.

## Why `PAINT` is only `{Paint}`

- **`RasterTask` / `Rasterize` run on raster worker threads.** Their count tracks tiling and
  scheduler behaviour, not the page. They are not merely noisy, they are **anti-correlated**: ~35
  fire when *nothing* is dirtied, and 14 for 40 dirtied boxes.
- **`PaintImage` nests inside a `Paint`**, so counting it double-counts the same work. It is
  otherwise clean (exactly 10 for 10 images), so it is a candidate for its own field if anyone needs
  "how many images were drawn". It is not one today.

Both still appear in the event log and are reachable by name (`query events --name RasterTask`).
They are just not a count anyone should gate on.

## There is no composite count, deliberately

`UpdateLayer` + `Commit` measure **elapsed time, not work**. Same workload (`Paint` = 21 in all 12
runs), varying only `--settle`:

| `--settle` | 50 ms | 200 ms | 800 ms | 1600 ms |
| --- | --- | --- | --- | --- |
| `UpdateLayer` + `Commit` | 58, 60, 70 | 178, 220, 231 | 293, 401, 412 | 38, 227, 262 |
| `Paint` | 21, 21, 21 | 21, 21, 21 | 21, 21, 21 | 21, 21, 21 |

`Commit` is frames committed; `UpdateLayer` is about 2x that (per-layer per-frame). Both track wall
time. (1600 ms is erratic because Chrome stops committing once idle.) A number that answers "how
long did we wait" cannot be named `compositeCount` without inviting the misreading `diff` would then
gate on, so there is no such field. The compositor signal worth wanting is *layer count*, which is a
different measurement neither engine hands us today.

## The off-thread frame side track is display-only, for the same reason

Chrome's frame pipeline (`PipelineReporter` async slices + `BeginFrame`/`DrawFrame`/`DroppedFrame`/
`Commit`, all on the already-enabled `disabled-by-default-devtools.timeline.frame` category) is
parsed into a per-span side track under `--breakdown` (`SpanBreakdown.frames`). It is **display-only,
never gate-able**, by the same rule as `compositeCount`:

- Its counts are scheduler/settle noise. Same unchanged 20-box paint, N=10: the per-run
  `PipelineReporter` total swings **1->28** (compositor warmth + how many vsync ticks the settle
  window spans), and 20 recolored boxes present as the same **1** frame as 1 box -- so a frame count
  does not even track paint work. Contrast main-thread `Paint`: **21 in all 10 runs, zero variance**.
- Its stage slices (`BeginImplFrameToSendBeginMainFrame` -> ... ->
  `SubmitCompositorFrameToPresentationCompositorFrame`) are inter-event **durations** on scheduler/viz
  threads -- wall-time, not work, exactly what killed `UpdateLayer`+`Commit` above.

So the side track lives on the breakdowns, NOT on `RecordingSummary`; `assert`/`diff` read only the
summary, so they structurally cannot gate on it. Nothing in it is summed into a breakdown bar either
(the wall is main-thread self-time; these frames run off-thread). `Paint` stays the only exact,
gate-able rendering signal.

## Layer count is a CDP snapshot, not a windowed count

**[measured]** The *layer count* the composite section above says neither engine hands us IS
obtainable — but only as a point-in-time snapshot, never as a per-span count. CDP `LayerTree.enable`
+ `layerTreeDidChange` fires **only on a structural change**: run 0 reports a stable count (paint
probe **4**, forces-layout probe **8**) and runs 1-9 fire **0 times**, because recoloring boxes does
not restructure the layer tree. So a layer count is a CDP-bracket *snapshot* value, not a gate-able
per-interaction count — a steady-state interaction emits no event to window.

## Firefox: paint stays unmeasured, on purpose

A real Gecko dump has paint-ish markers -- `DisplayList`, `WrDisplayList`, `Image Paint`,
`RefreshDriverTick` on GeckoMain; `CompositeToTarget`, `CONTENT_FULL_PAINT_TIME` on Compositor.
`DisplayList` is the semantic analogue of Blink's `Paint` (both build a display list, neither
rasterizes). It still must not be mapped onto `paintCount`:

| dirtied regions | 0 | 20 | 40 |
| --- | --- | --- | --- |
| chrome `Paint` | 0 | 21 | 41 |
| gecko `DisplayList` | 1, 1 | 2, 2 | 2, 2 |

**Gecko emits one `DisplayList` per painted frame; Blink emits one `Paint` per dirtied chunk.** Same
concept, different denominator. Exporting both as `paintCount` would manufacture a cross-engine
comparison out of two unrelated numbers -- the trap [engine-mapping.md](./engine-mapping.md) exists
to prevent. Firefox reports paint as unmeasured, and `meta.notes` says so.

**If you wire Gecko paint up:** its window rule is bounded `start..end`, while Chrome's `inWindow` is
start-onward. Gecko paints on the next refresh tick *after* `run:end`, so the bounded rule yields
**0 for every paint marker**. Match the start-onward rule, or measure nothing.

## Settle does not explain count instability

Worth knowing before blaming the settle window for a noisy count: at `--settle 0`, **zero** events
land after `run:end`, and a raster-inclusive count still swings 103->173 *inside* the run window.
The settle window does admit frames that belong to no iteration (`inWindow` is start-onward with no
upper bound, by design), but that is a scope question, not a stability one.
