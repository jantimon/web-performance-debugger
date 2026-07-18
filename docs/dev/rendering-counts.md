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
