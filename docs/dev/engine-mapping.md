# Chrome <-> Firefox: what the names mean (internal)

> **Developer notes, not user documentation.** Nothing here is needed to *use* wpd; read the
> [README](../../README.md) for that. This file records how Gecko's profiler vocabulary maps onto
> Blink's DevTools-timeline vocabulary, and — more importantly — where the two look equivalent but
> are **not**. Read it before touching `trace/classify.ts`, `profile/gecko.ts`, or anything that
> claims a number is comparable across engines.

**Provenance.** Facts below are either (a) reproduced locally against `examples/forces-layout.mjs`
in both engines, marked **[measured]**, or (b) read out of mozilla-central / chromium at
tip-of-tree in 2026-07, marked **[source]** with a permalink. Nothing here is from vendor docs
alone: both engines' user-facing docs are silent or wrong on most of this.

Related: [gecko-profile-format.md](./gecko-profile-format.md) (raw dump schemas),
[cpu-profiling.md](./cpu-profiling.md) (passes, sampler contamination, what self-time includes).

## The naming map

| Gecko | Blink trace event / DevTools UI | Notes |
| --- | --- | --- |
| `Reflow <url>` (**label frame**) | `Layout` / "Layout" | `PresShell::DoReflow`; the URL is a dynamic label suffix, not part of the name |
| `Reflow (sync)` / `Reflow (interruptible)` (**marker**) | `Layout` | Marker name != label name. `(sync)` = non-interruptible, **not** "JS forced it" |
| `Styles` (**label + marker**, two different call sites) | `UpdateLayoutTree` / "Recalculate style" | `RestyleManager::ProcessPendingRestyles` (label) and `AutoProfilerStyleMarker` (marker) |
| `Style computation` (**label**) | *(inside `UpdateLayoutTree`)* | `ServoStyleSet::StyleDocument` |
| `Update stylesheet information` (**label**) | *(inside `UpdateLayoutTree`, untraced)* | `ServoStyleSet::UpdateStylist`; see below |
| `Container Query Styles Update` (**label**) | *(inside `Layout`)* | Blink has no container-query trace event at all |
| `UpdateContainerQueryStyles` (**marker**) | — | co-located with the label above, different name |
| `SetNeedStyleFlush` (**marker**, cause stack) | `ScheduleStyleRecalculation`, `*InvalidationTracking` | both name the *write* that dirtied things |
| `get Element.clientHeight` (**label**) | **nothing** | see [Chrome cannot name the property](#chrome-cannot-name-the-property) |

`RecalcStyles` is a **dead Blink name** — the modern event is `UpdateLayoutTree`. Likewise
`CompositeLayers` / `UpdateLayerTree` are legacy, replaced by `Commit`. `trace/classify.ts` keeps
all three so old traces still import; do not "clean them up".

### Label frames vs markers

Gecko has two independent instrumentation channels and **wpd only reads one of them**:

- **Markers** (`thread.markers`) -> the Marker Chart. This is what `profile/gecko.ts` parses.
- **Label frames** (pushed on the `ProfilingStack`, sampled) -> the Stack Chart. wpd sees these
  only incidentally, as frames inside the CPU model.

The trap: **`Reflow` and `Reflow (sync)` are not the same record.** Searching the marker table for
`Reflow` finds `Reflow (sync)`; searching the stack chart finds `Reflow <url>`. Same `DoReflow`
scope, two different names, two different channels.

`Style computation` is stranger still: the literal string appears at **no call site**. It is a
*subcategory label* in `profiling_categories.yaml`, reached via
`AUTO_PROFILER_LABEL_CATEGORY_PAIR_RELEVANT_FOR_JS(LAYOUT_StyleComputation)`, which pushes an empty
label plus `LABEL_DETERMINED_BY_CATEGORY_PAIR`; the frontend substitutes the subcategory's label at
render time. **[source]** [`ProfilingStack.h:215`](https://searchfox.org/mozilla-central/source/js/public/ProfilingStack.h#215).
Grepping mozilla-central for `"Style computation"` finds nothing, which is why it looks like it
comes from nowhere.

### `Update stylesheet information` is not "forced style recalc"

Recurring misreading, worth stating plainly. **[source]**
[`ServoStyleSet.cpp:1380`](https://searchfox.org/mozilla-central/source/layout/style/ServoStyleSet.cpp#1380):

```cpp
void ServoStyleSet::UpdateStylist() {
  AUTO_PROFILER_LABEL_RELEVANT_FOR_JS("Update stylesheet information", LAYOUT);
  MOZ_ASSERT(StylistNeedsUpdate());
  ...
  Servo_StyleSet_FlushStyleSheets(mRawData.get(), root, snapshots, &nonDocumentStyles);
```

It rebuilds the **stylist** (cascade data derived from author sheets) and runs only when a
stylesheet was added/removed/mutated (`SetStylistStyleSheetsDirty`). It recalculates **no element's
style**. The frame that does that is `Styles` -> `Style computation`.

Blink's counterpart is `StyleEngine::UpdateActiveStyle()`, and the interesting part is where it
sits — **inside** the `UpdateLayoutTree` begin/end pair. **[source]**
[`document.cc:2704`](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/core/dom/document.cc#L2704):

```cpp
TRACE_EVENT_BEGIN("blink,devtools.timeline", "UpdateLayoutTree", "beginData", ...);
...
style_engine.UpdateActiveStyle();     // the "Update stylesheet information" equivalent
...
UpdateStyle();                        // the actual recalc
TRACE_EVENT_END("blink,devtools.timeline", "elementCount", element_count);
```

`UpdateActiveStyleSheets` traces on `blink,blink_style` — **not** `devtools.timeline` — so DevTools
never records it. Chrome folds stylist-rebuild cost invisibly into one "Recalculate style" bar.
So a Gecko profile showing this frame under JS tells you something Chrome actively hides: the
flush also had to rebuild cascade data, which is the expensive variant.

## Chrome cannot name the property

The single largest asymmetry, and it favours Firefox.

Gecko labels every WebIDL accessor. `get Element.clientHeight` is generated by
`CGSpecializedGetterCommon.auto_profiler_label` **[source]**
[`Codegen.py:11482`](https://searchfox.org/mozilla-central/source/dom/bindings/Codegen.py#11482);
the `get ` prefix is applied at *serialization* via the `STRING_TEMPLATE_GETTER` flag, so the call
site only stores `"Element", "clientHeight"`. Category is **DOM**, not Layout. No feature flag
gates it: the labels compile into every binding and cost nothing while the profiler is off.

Blink throws the property identity away immediately. `Element::OffsetHeight`,
`GetBoundingClientRect` and ~24 siblings in `element.cc` all funnel into
`EnsurePaintLocationDataValidForNode(this, DocumentUpdateReason::kJavaScript)`, and
`DocumentUpdateReason` lives under `public/common/**metrics**/` — it reaches UKM, never the trace.
DOM accessors are V8 API C++ getters and push **no JS frame**.

Net: Chrome gives you a JS stack and you read the source line to learn *which* property forced the
layout. Firefox names the accessor outright. This is why
[`what-forces-layout`](https://gist.github.com/paulirish/5d52fb081b3570c81e3a) exists as a hand-maintained
list at all — and that gist has **no per-property Gecko data**; it only points at `FrameNeedsReflow`
on searchfox.

## "Forced reflow" is a Blink concept; Gecko has the data but not the word

Searching mozilla-central for `forced reflow` / `forced synchronous layout` returns **zero** code
hits. Gecko never uses the vocabulary and Firefox DevTools surfaces no equivalent warning.

What Gecko has instead is the **cause stack**: `profiler_capture_backtrace()` fires in
`SetNeedLayoutFlush` / `SetNeedStyleFlush`, is stored on the PresShell (`mReflowCause` /
`mStyleCause`), and is moved onto the flush marker when it eventually runs. **This captures the
invalidator, not the forcer** — see
[forced-layout blame differs by engine](#forced-layout-blame-differs-by-engine), which is the most
consequential entry in this file.

Do **not** read `Reflow (sync)` as "JS forced this". `aInterruptible` is a plain parameter of
`DoReflow`; container-query updates call `DoFlushLayout(/* aInterruptible = */ false)` with no JS
involved. `(sync)` means non-interruptible, nothing more.

### wpd's `markForced` is not DevTools' rule either

Worth knowing before someone "aligns" us with DevTools. `markForced` flags a layout/style event
that resolved a user stack (`event.at`). DevTools' `WarningsHandler.ts` **ignores the stack** and
requires *structural nesting inside a JS invocation event* **and** a **>=30ms per-task aggregate**
(`FORCED_REFLOW_THRESHOLD`). The two correlate in practice — the stack is only attached when JS is
on the stack — but wpd flags cheap forced layouts DevTools stays silent about. That is arguably the
better rule for a CI gate; it is simply not the same rule, and CLAUDE.md must not imply it is.

## Forced-layout blame differs by engine

**[measured]** This is a real, reproducible semantic difference in `query blame --forced`, not a
subtlety.

`examples/forces-layout.mjs` separates the two halves cleanly: it writes inside `bump()` and reads
each geometry property on its own line. Same module, both engines:

- **Chrome**'s `.stack` blames `52:14`, `56:14`, `60:14`, `64:14`, `68:14`, ... — every geometry
  **read**.
- **Gecko's marker cause stack** names `15:3`, `13:14` (inside `bump`), `21:3` (inside `bumpDoc`),
  ... — the **writes**; Chrome's read stacks produce **zero** of those lines. This is why wpd keeps
  the marker cause OFF `query blame` (see below) and samples the read site instead.

Because:

| | Chrome | Gecko |
| --- | --- | --- |
| stack source | `SetCallStack` at the flush | `profiler_capture_backtrace()` at invalidation |
| answers | **who forced it** (the read) | **who dirtied it** (the write) |
| coverage | every flush | only the *first* invalidation since the last flush (`if (!mReflowCause)`) |

The cause chain [gecko-profile-format.md](./gecko-profile-format.md) records for a Gecko flush
marker (`Node.appendChild -> ...`) is the tell: `appendChild` is the **write**, not a geometry read.

**So `query blame --forced` no longer uses that marker cause.** The read site is instead **sampled
from the stacks**: a DOM-accessor label frame (`get HTMLElement.offsetWidth`) sitting over a
Layout-category flush, attributed to the nearest JS ancestor's per-sample **executing line**
(`frameTable.line`), with the property named. Measured [GL-1]: 12/21 of Chrome's read lines matched
exactly, **zero** landed on a marker write line, and the other recovered lines are the same read
statements with Gecko's per-sample line lagging one executed statement (10 of 11 exactly N-1).
`meta.blameSemantic` is `flush-site` on both engines; the write cause stays reachable under
`args.data.invalidationStack` for `query get`, but is not the `--forced` answer.

Two caveats remain, both honest and documented in the blame output:

- The read line is a **sampled estimate** at Gecko's ~1ms interval, so cheap reads can be missed and
  a line can lag one statement. (Chrome's `.stack` is exact.)
- Firefox's marker-derived `forcedLayoutMs` still under-reports the flush duration: **1.08ms vs
  Chrome's 7.17ms** (**7x**) for identical work on this probe at low iterations. That number comes
  from the Reflow/Styles markers, which also drive `forcedLayoutCount`; the read-site blame events
  are `sampled` and never enter those counts.

The CPU lane corroborates the read-site direction: the sampled CPU model attributes forced-layout
cost to the **forcing** frame on both engines (`run()` at **8.41ms** chrome / **8.79ms** firefox,
agreeing within 5%). See
[cpu-profiling.md](./cpu-profiling.md#what-self-time-actually-includes).

## Chrome's write side: dirtied-by + the thrash detector (`--deep`)

Chrome's `.stack` names the **read** that forced a flush; Chrome's `invalidationTracking` records name
the **write** that dirtied the DOM. `--deep` captures both, so on Chrome (and only Chrome) a forced
flush carries both causal ends: `forced-by` (the read) and `dirtied-by` (the write). Firefox has no
`invalidationTracking`, so its `--deep` write side would come from the marker cause stack instead
(reachable under `args.data.invalidationStack`), never surfaced as this dual annotation.

**[measured]** on `examples/forces-layout.mjs` under the full trace, main thread, `ts`-ordered:

- **Dirtied-by comes from the STYLE-kind invalidation record, never `LayoutInvalidationTracking`.**
  On this style-driven workload the layout dirty bit is set *during* the forced style recalc, so
  `LayoutInvalidationTracking`'s stack names the forcing **read** (`52:14`, ...), not the write. The
  genuine write line is on the style-kind record: `StyleRecalcInvalidationTracking reason="Inline CSS
  style declaration was mutated"` -> `bump` (line 16), and `reason="Node was inserted into tree"` ->
  the `appendChild` (line 38). So the detector reads dirtied-by off the style-kind mutation record and
  ignores the layout record's stack. A workload that dirties layout *directly* (`appendChild`,
  `textContent`, `.className` affecting geometry) would put a real write stack on
  `LayoutInvalidationTracking`; this probe never does, so that path is **[unprobed]** and layout-kind
  stacks are not trusted as dirtied-by.

- **The thrash rule matches by kind.** A forced flush is a thrash step iff a write of *its own* kind
  (a layout write for a `Layout` flush, a style write for an `UpdateLayoutTree`) sat in the gap since
  the previous flush in the same top-level `RunTask`. All 43 forced flushes on the probe sit in ONE
  `RunTask` (the whole `run()`), and the interleave is stable across runs with zero `ts`-inversions.
  Matching by kind counts **42 of 43** flushes; the one it drops is the `focus()` Layout re-read,
  whose gap holds only a `:focus`-recalc style write and no layout write -- a genuine non-thrash (it
  re-read clean geometry). Relaxing to "any layout|style write in the gap" reaches 43/43 but counts
  that clean re-read, so wpd keeps the matching-kind rule and accepts the one-step under-count.

## What is actually comparable across engines

**[measured]**, same probe, and it inverts the hierarchy the README currently implies:

| Signal | chrome | firefox | comparable? |
| --- | --- | --- | --- |
| CPU self-time of the forcing fn | 8.41 ms | 8.79 ms | **yes, ~5%** |
| `interaction.processingMs` | 45.1 ms | 45.0 ms | **yes, ~0.2%** |
| forced-blame read line | exact (`.stack`) | sampled (~1 ms) | **yes, line granularity** (12/21 exact) |
| `inpMs` | 56 ms | 48 ms | no, and see below |
| forced layout ms | 7.17 ms | 1.08 ms | no, 7x |
| layout batches | 22 | 70 | no, 3x |
| style batches | 23 | 45 | no, 2x |
| elements styled | 30 | 56 | same *definition*, still ~2x |

The `processingMs` row is **[measured]** on a click handler that busy-waits a known 45 ms
(`test/fixtures/slow-handler.html`), and it is the second signal that survives the crossing. Both
engines recover the number we chose, because both are timing the same handler with their own in-page
clock.

It also explains why `inpMs` does **not** cross. Splitting the same runs: chrome
`0.1 + 45.1 + 10.8`, firefox `0 + 45.0 + 3.0`. The engines agree on the handler to 0.1 ms and
disagree on **presentation delay** by 3.6x. So an INP difference between the two engines is a
rendering-pipeline difference, not a JS one, and `wpd record` prints the split that says so.
Consistent with the independent measurement in
[gecko-profile-format.md](./gecko-profile-format.md) (chrome processing 112.2 + presentation 47.4 vs
firefox 111.0 + presentation 16.0 on a 100 ms handler): same conclusion, different probe.

Counts and marker-ms are genuinely not comparable across engines — Gecko batches layout differently
and its markers miss short flushes. But **CPU self-time is**, because both samplers attribute the
synchronous engine work to the JS frame that triggered it, and both measure it on their own clock.
That is the opposite of how the README ranks these, and it is a strong argument for the CPU lane
being on by default.

The pattern in what crosses: **the signals that cross are the ones each engine times on its own
clock (self-time, processing); the ones that do not are the ones each engine counts or batches by
its own rules** (layout batches, marker-ms), plus presentation delay, where the engines genuinely
differ. That is a better predictor than the tier list, and worth applying before assuming a new
signal is comparable.

Caveat: the self-time row is one probe, ~85% reflow by cost. Reproduce on a mixed JS+layout workload
before promoting this claim to the README. The `processingMs` row is also one probe, and a
deliberately synthetic one (a busy-wait, no async work, no framework); a handler that yields would
split its cost across processing and presentation differently in each engine.

## Per-element counts: both engines have them, wpd reports neither

**[measured]** The premise worth stating first, because it is easy to assume otherwise: **CDP has no
per-element style-recalc counter.** `Performance.getMetrics` -> `RecalcStyleCount` counts recalc
*operations*. The per-element number is in the **trace**.

| | source | present today |
| --- | --- | --- |
| chrome elements styled | `UpdateLayoutTree` END arg `elementCount` | in `event.args` (23/23 events); never rolled up |
| chrome dirty objects | `Layout` `beginData.dirtyObjects` | in `event.args` (22/22 events); never rolled up |
| firefox elements styled | `Styles` marker `elementsStyled` | **dropped** — `geckoToRenderingEvents` reads only `data.stack` |

The Gecko `Styles` marker payload is richer than Chrome's, verified in our own fixture:

```json
{"type":"Styles","elementsTraversed":14,"elementsStyled":13,"elementsMatched":13,
 "stylesShared":0,"stylesReused":0}
```

`elementsTraversed` (140) vs `elementsStyled` (56) on the probe is **selector-matching waste** — a
Gecko-only signal with no Chrome counterpart, and a partial stand-in for the invalidation rollup
Firefox cannot give. Note the `Reflow` marker payload is only `{innerWindowID, stack, type}`:
**style has element counts, layout does not.**

These are *size* metrics, so they belong in the "counts are exact, compare freely" trust tier —
within an engine. They do **not** make the engines comparable (same ~2x ratio as the batch counts).

## Categories (Gecko)

From `profiling_categories.yaml`, which is the source of `meta.categories` in the dump, so frontend
colours derive straight from it:

| Frame | Category | Colour |
| --- | --- | --- |
| `Reflow <url>` | LAYOUT / `LAYOUT_Reflow` | purple |
| `Styles`, `Container Query Styles Update`, `Update stylesheet information` | LAYOUT | purple |
| `Style computation` | LAYOUT / `LAYOUT_StyleComputation` | purple |
| `get Element.clientHeight`, `Window.queueMicrotask` | **DOM** | **blue** |
| JS frames | JS | yellow |

`profile/gecko.ts` looks the JS category up **by name**, not by index, because the index is not
stable across versions.
