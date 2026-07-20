# What a driver step's numbers actually measure

Read this before changing `browser/driver.ts`, or before presenting a step's `wallMs` as a cost.

Everything below is **[measured]** against `test/fixtures/driver-probe.html` (40 rows appended with
an `offsetWidth` read between each, so every row forces a synchronous layout) and
`test/fixtures/slow-handler.html` (a click handler that busy-waits a known 45 ms), headless Chrome.

Every wall/settle number below is measured under **new-headless** (`--headless-mode new`, full
Chrome, ~60 Hz cadence). On the default shell mode (chrome-headless-shell, ~120 Hz) the settle floor
is ~half of these figures; the drive-independent counts and self-time are unchanged.

## A driver step's `wallMs` is the page's own clock, not a node-side bound

A step's stored wall (`Span.wallMs`) is measured on **the page's own clock**, between the step's two
`wpd:step:N` marks (placed in-page around `await action()` + `waitDone(until)`):

- on `--breakdown` / `--deep`, where a trace is captured, it is the **trace-clock window** between
  those marks (`t1 - t0`, in `applyTraceWall`), so it shares the clock the breakdown bar tiles and
  `Σ slices + idle = wall` holds;
- in the default capture mode, where there is no trace, it is the page's **`performance.now()` delta** between
  the marks.

`Span.wallClock` records which clock priced it: `"trace"` or `"page"`. A step that navigated in a
no-trace capture mode reports `wallMs` null: the two marks sit on documents with different `timeOrigin`s, so
their `performance.now()` delta is not one interval; in a trace capture mode the trace-clock window spans the
navigation and prices it.

### Why not the node-side bound

The obvious measurement is node-side (`node:perf_hooks`) around `await action()` **plus**
`waitDone(until)`. It is **not** the step wall, because it carries the tool's own input dispatch and
settle in **no renderer timeline**, so it cannot reconcile against the breakdown bar. The same 40-row
forced-layout work, driven three ways, is what that node-side bound *would* read:

| how it was driven | action | settle | node-side wall |
| --- | --- | --- | --- |
| nothing at all (empty action) | 0.00 | ~31 | **31.6** |
| `page.evaluate(() => el.click())` | ~2 | ~29 | **31.9** |
| `page.click('#inc')` | **~20** | ~20 | **40.5** |
| `--bench` (timed in-page) | | | **1.1** |

Three things that bound shows, and all three are why the step wall is priced on the page clock
instead:

- **The page ran 1.1 ms of JS in the 40.5.** The rest is the tool: input dispatch, plus a frame wait
  the tool performs on purpose. "The rest is overhead" is the wrong reading of that -- the two
  numbers do not time the same window (see `--bench` below), so the gap is not a correction you can
  subtract.
- **`page.click` alone costs ~20 ms** of Puppeteer/CDP input dispatch (mouse move, hit test,
  dispatch). It is not a round-trip cost: an empty `page.evaluate` round trip is **~0.5 ms**, i.e.
  noise. Driving identical work two ways moves that bound by 8 ms.
- **The settle floor is ~31 ms**, two animation frames, and it is *deliberate* (`inWindow` is
  start-onward by design; async paints land after `run:end`). It is most of a fast step's wall.

Even on the page clock the step wall is not the render cost: the window between the marks still
includes that deliberate settle (the input-dispatch wait lands in it as idle, which is why the bar
reconciles). So wall answers **"how long until the page settled"**, not "what did this cost".
`--iterations` makes that number *stable*, which makes it more dangerous rather than less: a
low-variance median invites the trust its sensitivity does not earn.

**Do not try to subtract the settle back out.** It is not a constant: it depends on how the step
is driven (20 ms vs 2 ms above), and the settle partly absorbs the action (`page.click`'s settle
measures ~20 ms where an empty action's measures ~31 ms, because the handler ate into the frame).
Same rule as the sampler contamination in [cpu-profiling.md](./cpu-profiling.md): a measured
constant is not a correction factor.

**A step whose end mark was lost falls back to the page clock** (`wallClock: "page"` beside a
`breakdown` bar), and then it does not reconcile: the bar tiles the trace window, while the wall came
from `performance.now()`, so `Σ slices + idle = wall` no longer holds for that step. The mismatch is
the tell that a mark went missing.

## What *does* describe the page

All of these are drive-independent. Measured, identical work via `page.click` vs `page.evaluate`:

| signal | via click | via evaluate | |
| --- | --- | --- | --- |
| `interaction.processingMs` | 1.70 | n/a | in-page, the handlers themselves |
| `layoutCount` / `forcedLayoutCount` | 41 / 80 | 41 / 80 | identical |
| `wallMs` | 40.5 | 31.9 | **not** |

The per-step counts are trace-derived, windowed to the step's own trace window (in a trace capture mode), so
they never carried the driver's overhead in the first place. Only the wall does.

## The CWV split, and why it needs `interactionId`

`interactionBreakdown` (in `driver.ts`, pure and unit-tested) splits the worst interaction into
input delay / processing / presentation delay from the same Event Timing entries the INP observer
already collects. On the 45 ms-handler probe it reads **processing 45.1**, i.e. it recovers a number
we chose, to 0.1 ms.

Two facts the implementation depends on:

- **Chrome emits the whole pointer sequence** (`pointerover`, `pointerenter` x4, `mouseover`,
  `pointerdown`, `mousedown`, `pointerup`, `mouseup`, `click`), and **on a zero-delay `page.click`
  every entry shares one duration to the same next paint** (all `64` on the 45 ms probe). That is
  what lets `Math.max` over durations find the interaction's latency without grouping, which is why
  `inpMs` does not group; the behaviour is verified in both engines in
  [gecko-profile-format.md](./gecko-profile-format.md).

  **This does not generalize to a held press.** With `page.click(sel, { delay: 250 })` -- an
  ordinary human press is ~100 ms -- the interaction spans **two paints**: `pointerdown`
  `duration: 24` painting at 43.3, then `pointerup`/`click` `duration: 64` painting at 336.1. One
  interactionId, two durations. So "every entry shares one duration" is a property of a synthetic
  instant click, not of Chrome.
- **Only the interaction's own events carry a non-zero `interactionId`** (`pointerdown`,
  `pointerup`, `click`; the rest are `0`). The *breakdown* must group by it: on a plain click the
  entries tie on duration, and picking one by duration alone could read processing off
  `pointerover`, which measured **0.10** against the click's **45.20**.
- **The breakdown then keeps only the entries at the worst duration**, because an interaction can
  span paints. Reading `startTime` off `pointerdown` and `duration` off `click` on the held press
  above reports `processingMs 297.5` and `presentationDelayMs -241.8` for a 45 ms handler; anchoring
  on the earliest event instead prices `pointerdown`'s own paint and reports `processingMs 15.7`,
  losing the handler. Anchoring on the max-duration entries gives **45.3**, because that duration IS
  the latency INP reports.

`processingStart`/`processingEnd` are **not** rounded, unlike `duration`, which the spec rounds to
8 ms. So the split is finer-grained than the INP it decomposes: a 45 ms handler reads
`processingMs` 45.4 inside an `inpMs` of 64.

## It crosses engines, and it explains the INP gap

**[measured]** the same 45 ms-handler probe, both engines:

| | chrome | firefox |
| --- | --- | --- |
| `inpMs` | 56 | 48 |
| input delay | 0.1 | 0 |
| **processing** | **45.1** | **45.0** |
| presentation delay | 10.8 | 3.0 |

`processingMs` crosses (0.2% apart); `inpMs` does not. The whole gap is **presentation delay**, so
"Firefox reads a lower INP for identical work" is a rendering difference, not a JS one, and the
split is what says so. That makes `processingMs` the second signal
comparable across engines, alongside CPU self-time; see
[engine-mapping.md](./engine-mapping.md#what-is-actually-comparable-across-engines). Firefox appears
to round the parts to whole ms where Chrome does not.

## Limits worth knowing before you rely on it

- **Untrusted events produce nothing.** `page.evaluate(() => el.click())` fires a synthetic click,
  which Event Timing does not observe: measured **0 entries**. A programmatic step therefore has no
  INP and no breakdown, and that is not a bug to fix. Time programmatic work with `--bench --url`
  instead, which runs in-page with full DOM.
- **The settle heuristic can fire mid-stream on a soft navigation.** The default `until` is two
  rAF+idle cycles (`SETTLE_SOURCE` in `settle.ts`), which resolves the moment the page goes briefly
  idle. On a streamed / soft-navigating SPA (a Next.js route transition whose markup arrives in
  chunks) that idle gap opens *before* the content lands: **[measured]** ~57 ms of settle against
  ~171 ms until the route actually painted, on a production Next.js site. The step wall then prices an
  empty frame, not the transition. Pass an explicit `until:` (a selector matching the landed content,
  or an async predicate) for any soft-nav step; the heuristic is only safe when the whole update lands
  in one rAF. **`waitForStable(page, { selector, quietMs })`** (exported from the package, `until.ts`)
  is the ready-made opt-in: it waits for `selector`, then for the DOM to go `quietMs` (default 200) with
  no mutation, which the default settle cannot see because a streamed route keeps mutating past the
  first idle gap. Reproduced against a streamed injection: the default settle resolves ~24 ms in while
  the last chunk lands ~173 ms in; `waitForStable` resolves after it. It is opt-in, never the default:
  the default settle is the measured trade-off above, and `waitForStable` trades a longer, more
  variable wall (the `quietMs` tail rides on every step) for catching the whole transition. There is
  no `soft-navigation` performance entry to lean on: it ships only behind Chrome's
  `SoftNavigationHeuristics` flag (measured: absent from `supportedEntryTypes` by default), and setting
  an experimental flag would change the browser under test.
- **On a re-rendering SPA, drive the action with a plain `page.click('#stable-id')`.** Locator-style
  waits (`page.locator(sel).click()`, or `waitForSelector` then a click) re-resolve the element and
  hit **detached-node timeouts** when the framework replaces the node between the wait and the click.
  A direct `page.click` on a stable selector hit-tests and dispatches in one step, and is the trusted
  input Event Timing observes (unlike `page.evaluate(() => el.click())` above). It is the reliable
  form for the `action` a `measureStep` drives.
- **The 16 ms floor is the spec's.** `durationThreshold` below 16 is clamped, so an interaction
  faster than a frame produces no entry at all. A `null` INP means "nothing crossed 16 ms", not
  "the engine cannot measure it".
- **`--bench` has a DOM.** `run(ctx)` is imported *inside* the page and uses live
  `document`/`window`; it simply has no Puppeteer `page` handle to drive with, and `--url`
  still gives it a host page. It is the in-page-timed lane (1.1 ms vs the driver's 40.5 on identical
  work), and it is the right tool for a programmatic measurement that wants a real number.

  **Bench and the driver do not time the same window, so the gap between them is not overhead.**
  Bench times `run()` alone; the paint lands afterwards, on a later frame, and bench's wall never
  waits for it. The driver's wall does, deliberately. The counts come out identical either way
  (`inWindow` is start-onward, so the trace sees that paint on both lanes), and that is the trap:
  identical counts make "same work, same counts, so the difference is the tool" read as airtight
  when it is comparing a wall that waits for a frame against one that does not. The claim that
  survives is narrower and still worth the switch: bench prices the code, while the driver's wall is
  dominated by a frame wait that does not move when the code gets slower.
- **`performance.measure` spans are the third way, for a phase *inside* `run()`.** Under
  `--breakdown` (Chrome) and automatically on Firefox, any `performance.measure(name, a, b)` the page
  emits becomes its own reconciling span with a full breakdown, keyed by the measure name. So a
  sub-`run()` phase (an app's `__hydrateMs` / `__mountMs`) is timed in-page on the page's own clock —
  no driver wall, no frame wait, and finer-grained than bench's single `run()` window. `query spans
  latest` lists them; see [cpu-attribution.md](./cpu-attribution.md#which-spans-get-cpu-attribution).
- **A driver step's per-package/hot CPU can be empty even when its JS ms is real.** The V8 CPU
  profiler resets on each cross-document navigation, so a step window before the run's last navigation
  carries no samples: its bar shows JS ms (from the trace) but `js.byPackage` is `{}` and the hot list
  is suppressed with reason `not-covered` (raising `--iterations` cannot recover it; `breakdown-spans.ts`
  pushes one coverage-gap note when the symptom is present). The per-step "where did the JS go" then
  comes from two other signals: a `performance.measure` the app emits for that phase (a hydration /
  mount span DOES carry `byPackage` and hot functions, since a measure pools samples across its own
  in-`run()` occurrences), and the LoAF script list below. State this in user copy: the `query span`
  anatomy is uniform in shape across span kinds, not in which CPU fields each kind can fill.
- **A driver step carries Long Animation Frames (Chrome), attributing slow frames to scripts.** The
  driver arms an in-page `long-animation-frame` observer, reset per step (`driver.ts`), and stores the
  step's frames on `Span.loaf` (`summarizeLoaf`: worst-first frames, each naming its worst scripts by
  duration with the forced style/layout ms). Unlike the CPU sampler and the trace, the observer is
  **ungated by any capture cap**, so a step gets script-level attribution even in the default capture mode (no
  trace, no per-step counts) and even when the sampler could not cover its window. `sourceURL` is the
  served script url, not a source line: LoAF gives a character offset, not a line, so a line-level
  rewrite would be a guess. Chrome-only (measured: absent from Firefox's `supportedEntryTypes`), so a
  firefox/node step stores nothing rather than a fabricated zero.
- **A measure label that repeats gets a median, not iteration 1.** `--iterations`/`--warmup` re-run
  `run()`, so a label emitted inside `run()` recurs once per iteration (and can recur within one),
  mirroring `mergeSteps`. `mergeSpanOccurrences` (`model/span-merge.ts`) keys those occurrences by
  label and reports the one whose `breakdown.wallMs` is the lower median across them, VERBATIM — a
  real reconciling sample, so `Σ slices + idle = wall` still holds byte-for-byte (per-slice averaging
  would fabricate a bar no occurrence produced). The merged span discloses `aggregation: "median"`,
  `samples`, and the `wallMinMs`/`wallMaxMs` spread; single-occurrence measures pass through as
  `"first"` and run spans stay `"sum"`. Occurrence begin/end pairing is FIFO per label
  (`breakdown-spans.ts`), which handles sequential same-label repeats but cross-pairs nested or
  overlapping same-label measures into the wrong window.
