# Forced-layout blame: read sites, write sites, and the thrash detector (internal)

> **Developer notes, not user documentation.** Nothing here is needed to *use* wpd; read the
> [README](../../README.md) for that. This file records the blame semantics `query blame --forced`,
> the dirtied-by report, and the thrash detector depend on: which end of the write->read causal pair
> each engine can name, and by what mechanism. Read it before touching `trace/analysis.ts`
> (`markForced`), `trace/thrash.ts`, `trace/firefox-dirtied.ts`, or the blame output.

**In this file:** [the "forced reflow" vocabulary and Gecko's cause stack](#forced-reflow-is-a-blink-concept-gecko-has-the-data-but-not-the-word)
· [wpd's rule vs DevTools' rule](#wpds-markforced-is-not-devtools-rule-either)
· [read-site vs write-site blame across engines](#forced-layout-blame-differs-by-engine)
· [Chrome's dirtied-by + thrash detector](#chromes-write-side-dirtied-by--the-thrash-detector---deep)
· [Firefox's first-invalidation dirtied-by](#firefoxs-write-side-partial-dirtied-by-first-invalidation-only---deep)

**Provenance.** As in [engine-mapping.md](./engine-mapping.md): facts are **[measured]** against
`examples/forces-layout.mjs` in both engines, or **[source]** with a permalink. Related:
[engine-mapping.md](./engine-mapping.md) (what the engine vocabularies mean),
[gecko-profile-format.md](./gecko-profile-format.md) (how the cause stack is encoded in the dump),
[cpu-profiling.md](./cpu-profiling.md) (the CPU lane's own forced-layout attribution).

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

**So `query blame --forced` does not use that marker cause.** The read site is instead **sampled
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
the **write** that dirtied the DOM. `--deep` captures both, so on Chrome a forced flush carries both
causal ends: `forced-by` (the read) and `dirtied-by` (the write), and the FULL write set in a flush's
gap is what lets the thrash detector run.

**[measured]** on `examples/forces-layout.mjs` under the full trace, main thread, `ts`-ordered:

- **Dirtied-by comes from the STYLE-kind invalidation record, plus one reason-keyed layout case.**
  On a style-driven workload the layout dirty bit is set *during* the forced style recalc, so
  `LayoutInvalidationTracking`'s stack names the forcing **read** (`52:14`, ...), not the write. The
  genuine write line is on the style-kind record: `StyleRecalcInvalidationTracking reason="Inline CSS
  style declaration was mutated"` -> `bump` (line 16), and `reason="Node was inserted into tree"` ->
  the `appendChild` (line 38). **[measured]** across direct-layout-dirtying workloads
  (append/remove, `textContent`, geometry `classList`, `input.value`, 3 runs each, byte-stable): the
  layout record's stack semantics are a clean binary on its reason string. `reason="Removed from
  layout"` stamps at the synchronous DOM detach and names the **write** (and pure `removeChild`
  emits no style-kind write at all, making it that case's only write signal); `reason="Added to
  layout"` and `"Style changed"` stamp at the forced recalc and name the **read**. So the detector
  reads dirtied-by off the style-kind mutation records plus layout-kind `"Removed from layout"`
  records, and trusts no other layout-kind stack. **[measured]** `display:none` removal (class-toggled
  and inline, 3 runs each, byte-stable) also emits `"Removed from layout"`, but stamped at **recalc**
  time with the geometry read on the stack, so its `at` is byte-equal (line AND column) to the flush's
  own read-site. The detector drops a `"Removed from layout"` dirtied-by entry whose `at` equals the
  flush read: a synchronous detach names a distinct write line, so a position-equal entry is the
  recalc-time stamp naming the read, not a write. The genuine mutation survives on the co-emitted
  style-kind record (`"Related style rule"` / `"Inline CSS ... mutated"`) at the real toggle line, and
  the thrash count (read from `gapLayoutWrites` before the filter) is untouched.

- **The thrash rule matches by kind.** A forced flush is a thrash step iff a write of *its own* kind
  (a layout write for a `Layout` flush, a style write for an `UpdateLayoutTree`) sat in the gap since
  the previous flush in the same top-level `RunTask`. All 43 forced flushes on the probe sit in ONE
  `RunTask` (the whole `run()`), and the interleave is stable across runs with zero `ts`-inversions.
  Matching by kind counts **42 of 43** flushes; the one it drops is the `focus()` Layout re-read,
  whose gap holds only a `:focus`-recalc style write and no layout write -- a genuine non-thrash (it
  re-read clean geometry). Relaxing to "any layout|style write in the gap" reaches 43/43 but counts
  that clean re-read, so wpd keeps the matching-kind rule and accepts the one-step under-count.

### Firefox's write side: partial dirtied-by, first-invalidation-only (`--deep`)

Firefox has no `invalidationTracking`, but a Gecko Reflow/Styles marker's **cause stack natively names
the write** that dirtied the flush. So `--deep --target firefox` is not empty and not chrome-in-a-wig:
it is the same one gecko pass, plus that write identity surfaced as a `dirtied-by (first invalidation
only)` report. The write is the innermost JS caller of the marker's cause stack (`args.data.invalidationStack`,
resolved to a source line); it is deliberately kept off `blame`'s `at`, which stays the read (the
sampled read-site events, unchanged by `--deep`). This is the pleasing symmetry: Chrome *adds*
dirtied-by via `invalidationTracking` and alone names the read; Firefox has the write natively and its
read is the sampled estimate. Both engines end dual-annotated on the write, stated per engine, never
implied as parity.

The scope is the honest limit, and the code states it everywhere (`semantic: "first-invalidation"`,
`forced-by: n/a (firefox --deep)`): Gecko records only the **FIRST invalidation since the last flush**,
so a flush names ONE write, not the full set of writes in its gap. That is why this lane runs **no
thrash detector** (the detector needs every write in a gap to see write->read->write interleaving) and
claims **no exact-count parity** with Chrome. Comparable to Chrome's dirtied-by at line granularity,
but a partial write set, never the input to a thrash headline.
