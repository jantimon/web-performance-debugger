# What a driver step's numbers actually measure

Read this before changing `browser/driver.ts`, or before presenting a step's `wallMs` as a cost.

Everything below is **[measured]** against `test/fixtures/driver-probe.html` (40 rows appended with
an `offsetWidth` read between each, so every row forces a synchronous layout) and
`test/fixtures/slow-handler.html` (a click handler that busy-waits a known 45 ms), headless Chrome.

Every wall/settle number below is measured under **new-headless** (`--headless-mode new`, full
Chrome, ~60 Hz cadence). On the default shell mode (chrome-headless-shell, ~120 Hz) the settle floor
is ~half of these figures; the drive-independent counts and self-time are unchanged.

## `wallMs` is a bound on the step, not the cost of the page

A step's wall is measured **node-side** (`node:perf_hooks`), around `await action()` **plus**
`waitDone(until)`:

```js
const t0 = performance.now();   // node
await action();                 // e.g. () => page.click('#x')
await waitDone(until);          // settle, or the until-condition
const wallMs = performance.now() - t0;
```

So it carries the driver's own cost. The same 40-row forced-layout work, driven three ways:

| how it was driven | action | settle | wall |
| --- | --- | --- | --- |
| nothing at all (empty action) | 0.00 | ~31 | **31.6** |
| `page.evaluate(() => el.click())` | ~2 | ~29 | **31.9** |
| `page.click('#inc')` | **~20** | ~20 | **40.5** |
| `--bench` (timed in-page) | | | **1.1** |

Three things follow, and all three are counter-intuitive enough to be worth stating outright:

- **The page ran 1.1 ms of JS in the 40.5.** The rest is the tool: input dispatch, plus a frame wait
  the tool performs on purpose. "The rest is overhead" is the wrong reading of that -- the two
  numbers do not time the same window (see `--bench` below), so the gap is not a correction you can
  subtract.
- **`page.click` alone costs ~20 ms** of Puppeteer/CDP input dispatch (mouse move, hit test,
  dispatch). It is not a round-trip cost: an empty `page.evaluate` round trip is **~0.5 ms**, i.e.
  noise. Driving identical work two ways moves the wall by 8 ms.
- **The settle floor is ~31 ms**, two animation frames, and it is *deliberate* (`inWindow` is
  start-onward by design; async paints land after `run:end`). It is most of a fast step's wall.

Therefore a 15% regression in 9 ms of real work moves a 40 ms wall by ~3%. `--iterations` makes that
number *stable*, which makes it more dangerous rather than less: a low-variance median invites the
trust its sensitivity does not earn. Wall answers **"how long until the page settled"**. It does not
answer "what did this cost".

**Do not try to subtract the overhead back out.** It is not a constant: it depends on how the step
is driven (20 ms vs 2 ms above), and the settle partly absorbs the action (`page.click`'s settle
measures ~20 ms where an empty action's measures ~31 ms, because the handler ate into the frame).
Same rule as the sampler contamination in [cpu-profiling.md](./cpu-profiling.md): a measured
constant is not a correction factor.

## What *does* describe the page

All of these are drive-independent. Measured, identical work via `page.click` vs `page.evaluate`:

| signal | via click | via evaluate | |
| --- | --- | --- | --- |
| `interaction.processingMs` | 1.70 | n/a | in-page, the handlers themselves |
| `ScriptDuration` (per-step CDP) | 0.27 | 0.26 | identical |
| `layoutCount` / `forcedLayoutCount` | 41 / 80 | 41 / 80 | identical |
| `wallMs` | 40.5 | 31.9 | **not** |

The per-step CDP counters are bracketed around each `measureStep`, so they never carried the
driver's overhead in the first place. Only the wall did.

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
  INP and no breakdown, and that is not a bug to fix. Time programmatic work with `--bench --html`
  instead, which runs in-page with full DOM.
- **The 16 ms floor is the spec's.** `durationThreshold` below 16 is clamped, so an interaction
  faster than a frame produces no entry at all. A `null` INP means "nothing crossed 16 ms", not
  "the engine cannot measure it".
- **`--bench` has a DOM.** `run(ctx)` is imported *inside* the page and uses live
  `document`/`window`; it simply has no Puppeteer `page` handle to drive with, and `--html`/`--url`
  still give it a host page. It is the in-page-timed lane (1.1 ms vs the driver's 40.5 on identical
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
  latest` lists them; see [cpu-profiling.md](./cpu-profiling.md).
