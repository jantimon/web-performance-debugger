# Firefox backend: Gecko profile format notes (internal)

> **Developer notes, not user documentation.** Nothing here is needed to *use* wpd; if you are
> looking for how to run the tool, read the [README](../../README.md). This file records the
> empirically-verified Gecko profile format facts that `src/profile/gecko.ts` depends on, for
> whoever has to touch that code next (e.g. when a Firefox update bumps the format version).

**Scope.** This file is the **raw dump format**: schemas, encodings, bases. For what the names
*mean* against Chrome's vocabulary — and where the two engines look equivalent but are not — read
[engine-mapping.md](./engine-mapping.md). For the rung ladder and sampler behaviour, read
[cpu-profiling.md](./cpu-profiling.md).

Everything below was verified against a
real Gecko shutdown dump (Firefox 152.0.2 via Puppeteer 25 / WebDriver BiDi), not from docs alone.
A trimmed slice of a real dump is checked in at `test/fixtures/gecko-shutdown.trimmed.json`; to
regenerate a full one, launch Firefox via Puppeteer with the `MOZ_PROFILER_*` env vars from
`src/browser/launch.ts` and close the browser.

## Puppeteer + Firefox capability probe (verified)

- `puppeteer.launch({ browser: "firefox", headless, env })` launches the puppeteer-managed
  Firefox build. Confirmed working: `page.goto` (waitUntil load), `page.evaluate`,
  `page.evaluateOnNewDocument` (globals persist across navigations), `page.setViewport`,
  `page.screenshot`, reading `performance.getEntriesByType("mark")`.
- `page.createCDPSession()` **throws** (empty message). `page.tracing.start/stop` **throws**
  `"CDP support is required for this feature. The current browser does not support CDP."`
  So: no DevTools trace (hence no exact rendering counts), no CPU/network throttling, no
  invalidationTracking. Every CDP touchpoint is capability-gated behind
  `capsFor(browser).cdpCounts/trace/throttle`.
- **"We reach it through CDP" is not the same claim as "Gecko cannot do it", and a reject
  list conflates the two.** Two [measured] counter-examples worth knowing before adding a CDP-gated
  feature:
  - **Offline mode works over BiDi** (`browsingContext.setOfflineMode`, via
    `page.emulateNetworkConditions`); only the throughput presets (slow-3g and friends) throw
    `UnsupportedOperation`. So a network-emulation feature would not need CDP for the offline case even
    though a `CDPSession`-shaped `throttle.ts` reads as if it does.
  - `--protocol-timeout` is **not a CDP knob at all**, despite puppeteer's own docstring
    ("individual protocol (CDP) calls"). Puppeteer threads it into the BiDi connection
    (`BrowserLauncher` -> `BrowserConnector` -> `Connection`), where it bounds every `send()`,
    including the `session.new` handshake -- a BiDi-only command. Verified: `--protocol-timeout 1`
    reproduces `session.new timed out` on Firefox; a large value launches fine. Read puppeteer's
    code, not its docstring, before calling an option Chrome-only.
- `PerformanceObserver({ type: "event" })` **works**, and per-step INP is real: Firefox populates
  Event Timing entries, so INP is measured on this lane, not `null`. Measured on Firefox 152 /
  Chrome 150:
  - `supportedEntryTypes` includes `event`, `first-input`, `largest-contentful-paint`, `paint`
    (and `PerformanceEventTiming.interactionId` exists). It does **not** include `layout-shift`,
    `longtask`, or `element`, so CLS and long tasks cannot be sourced in-page here. wpd's long tasks
    come from the DevTools trace anyway, which Gecko has no equivalent of.
  - The driver's exact observer config is honoured: `durationThreshold: 16` and `buffered: true`
    neither throw nor silently drop entries.
  - One 100 ms click handler, identical page: chrome `duration` 160 ms (processing 112.2 +
    presentation 47.4) vs firefox 128 ms (processing 111.0 + presentation 16.0). **Both include the
    next paint and round to 8 ms** -- firefox is NOT a processing-only lower bound. The gap is real
    presentation-delay difference, so firefox reads systematically lower for identical work:
    comparable in direction, not interchangeable.
  - Coverage differs but loses nothing: chrome emits the whole pointer sequence (every entry sharing
    one duration to the same next paint), firefox emits only the events that did work
    (`pointerdown`/`mousedown`, or `keydown`/`keypress` when the handler lives there). The driver's
    `Math.max` over entries therefore finds the work in both engines.
  - Puppeteer dispatches a synthetic click's events within ~0.2 ms, so max-over-entries picks the
    same value as the `click` entry alone; there is no anchoring gap in practice.
  - A `null` INP on Firefox means what it means on chrome: no interaction crossed the 16 ms
    threshold (a fast or visually idempotent interaction), not an engine limitation.

## Gecko profiler via env vars (verified)

Started at launch and dumped on browser exit via `launch({ env })`:

- `MOZ_PROFILER_STARTUP=1`
- `MOZ_PROFILER_SHUTDOWN=<abs path>` (JSON written on `browser.close()`)
- `MOZ_PROFILER_STARTUP_FEATURES=js,cpu`. An explicit features string **replaces** Gecko's default
  set, so it must name everything wpd needs: `js` gives JS stacks, UserTiming markers, and
  Reflow/Styles markers with JS cause stacks; `cpu` populates the per-sample `threadCPUDelta` column
  (`js` alone leaves it structurally empty), whose ~0 values are the honest idle signal the
  reconciling bar tiles ([cpu-profiling.md](./cpu-profiling.md)). `stackwalk` is NOT added (zero
  signal on the shallow JIT stacks, and it would only add native C++ frames we collapse); neither is
  `cpuallthreads` (`cpu` reproduces the idle result sampling only registered threads).
- `MOZ_PROFILER_STARTUP_INTERVAL=1` (ms floor; the real sample delta measured was ~1ms median)
- `MOZ_PROFILER_STARTUP_ENTRIES=16000000` (big ring buffer so the window is not overwritten; NOT a
  size lever — undersizing silently drops the window's earliest samples, dumps stay ~15-23MB)

The dump is written **asynchronously** after `close()`. We poll for the file to exist AND stop
growing (3 stable reads, ~15s timeout) before parsing. A 4.5s workload produced a 26MB dump.

## Raw ("gecko") profile format (version 34) as actually observed

- Top level: `{ meta, libs, threads, processes[] }`. `threads[]` is the parent (default)
  process; `processes[]` are child processes and **nest recursively** (`processes[].processes[]`).
  Content (tab) process threads have `thread.processType === 2` and `thread.name === "GeckoMain"`.
  **We do NOT select by processType** (brittle: it appears as the number `2` on threads but the
  string `"tab"` on `process.meta.processType`). Instead we walk every thread recursively and pick
  the one whose marker table contains a `UserTiming` marker named `wpd:run:start`. Robust and
  picks the exact content process that ran the module even with 6 content processes present.
- Per-thread tables are `{ schema: {col: index}, data: [row[]] }`. Observed schemas:
  - `frameTable.schema = {location, relevantForJS, innerWindowID, implementation, line, column, category, subcategory}`
    There is **no funcTable** in the raw format. `location` is a stringTable index.
  - `stackTable.schema = {prefix, frame}` — a prefix tree. `prefix` = parent stack index (null at
    root), `frame` = frameTable index. Two call paths ending in the same frame are distinct stack
    nodes, exactly like V8 cpuprofile nodes.
  - `samples.schema = {stack, time, eventDelay, argumentValues, threadCPUDelta}`. `stack` =
    stackTable index (null = no stack), `time` = **ms float since profiling start** (NOT µs, NOT
    performance.now). `threadCPUDelta` was absent in our dump (trailing columns are omitted), so we
    use wall-time deltas like V8. `sampleUnits.time === "ms"`.
  - `markers.schema = {name, startTime, endTime, phase, category, data}`. `name` is a stringTable
    index; `phase`: 0=instant, 1=interval(start+end on one row), 2=intervalStart, 3=intervalEnd.
    `data` is a per-marker-type payload. The two we read differ sharply in richness:
    - `Styles` -> `{innerWindowID, stack, type:"Styles", elementsTraversed, elementsStyled,
      elementsMatched, stylesShared, stylesReused}` — a real **per-element style-recalc counter**,
      richer than Chrome's `UpdateLayoutTree.elementCount`. `geckoToRenderingEvents` currently reads
      only `data.stack` and **drops all five counts**; see
      [engine-mapping.md](./engine-mapping.md#per-element-counts-both-engines-have-them-wpd-reports-neither).
    - `Reflow (sync)` -> `{innerWindowID, stack, type:"StackMarker"}` — **no counts at all.**
      Style has element counts; layout does not.
  - `thread.stringTable` is a plain string array (the field is `stringTable`, not `stringArray`).
- **Frame location string formats** (a trailing `[NN]` innerWindowID subscript is always stripped):
  - `functionName (url:line:col)` for named JS functions. The `line:col` in the string is the
    **function definition** location (constant per function) — this is what we key on, matching V8's
    function-level self-time semantics. The separate numeric `frameTable.line/column` columns are the
    per-sample **execution** line (varies within a function); using those would fragment a function's
    self-time across its lines, so we ignore them for frame identity.
  - `url:line:col` for anonymous top-level code (e.g. `http://.../__blank__:1:8`).
  - bare `url` (no position) or a native label (`XRE_InitChildProcess`, `0x118ec1780`, `(root)`).
- **Line/column base: 1-based.** `hashString (cpu-busywork.mjs:6:20)` -> source line 6 is literally
  `function hashString(input) {`. We store `line-1`/`col-1` (0-based) in the `RawCallFrame` so the
  existing `resolveCallFrame` (which adds 1, per CDP convention) lands back on line 6. Verified
  end-to-end: the converter resolves `hashString` to `cpu-busywork.mjs:6`.
- **JS vs native:** a frame is JS iff `frameTable.category === <index of "JavaScript" in
  meta.categories>` (index 4 here; looked up by name for robustness). This correctly excludes
  Layout-category label frames like `"Layout http://..."` that contain a URL but are not JS. Only
  `http(s)://` / `file://` URLs are treated as resolvable source; `self-hosted`, `resource://`
  (Firefox internals), and empty URLs are kept as JS-engine builtins and bucket to `(native)`,
  never fs-walked (mirrors the pseudo-URL handling in `cpuprofile.ts`).
- **Converter node building:** each sample's stack is reduced to its JS-only frame chain (native
  frames dropped, matching a V8 JS-only profile). The chains are interned into a fresh prefix tree
  under a synthetic `(root)`; samples with no JS frames go to `(program)` (or `(idle)` if the leaf
  frame's category is Idle). Self time = per-sample wall delta (ms*1000 -> µs) attributed to the
  sample's node. The result is a standard `RawCpuProfile`, so `buildCpuModel` /
  `query cpu|frame` / `cpu-diff` are reused unchanged.

## Windowing without profiler start/stop control

Gecko records `performance.mark()` as **UserTiming markers**: `marker.name === "UserTiming"` with
the JS label in `data.name` (e.g. `data.name === "wpd:run:start"`). NOT a marker named `wpd:...`.
`data.entryType` is `"mark"` or `"measure"`. Times are on the same ms clock as samples. We slice
samples (and rendering markers) to `[wpd:run:start, wpd:run:end]`. Works in both bench and driver
modes (both already emit those marks).

## Reflow/Styles markers -> layout/style blame (see the semantics warning)

- Marker names: `"Styles"` (style recalc, phase 1 interval) and `"Reflow (sync)"` /
  `"Reflow (interruptible)"` (phase 2/3 start/end pairs). Category 3 = Layout. These are the
  **marker** names; the stack chart uses different strings for the same work (`Reflow <url>`) —
  see [engine-mapping.md](./engine-mapping.md#label-frames-vs-markers).
- **Cause stacks are real and resolvable.** A marker's `data.stack` is an embedded thread-shaped
  object whose `samples.data[0][0]` is a **stack index into the SAME host thread's stackTable**
  (not a self-contained mini-profile). We resolve it through the identical frame path as samples.
  We map `Styles -> style`, `Reflow* -> layout`, and set `forced: true` when a JS frame is on the
  cause stack (this drives `forcedLayoutCount`). The cause names the **write**, so it is NOT set as
  `event.at`; it is stashed in `args.data.invalidationStack` for `query get`. Markers with a
  native-only cause get counts + durations but no `forced`.
- **Blame comes from the samples, not the cause stack.** The marker cause is the **write** that
  dirtied the DOM (`Node.appendChild -> ...`), captured in `SetNeedLayoutFlush`/`SetNeedStyleFlush`
  (the invalidator, only the *first* since the last flush), whereas Chrome blames the flush-site
  **read**. So `geckoReadSiteBlameEvents` samples the read site instead: a DOM-accessor over a
  Layout-category flush, attributed to the JS ancestor's executing `frameTable.line` + property, as
  `sampled` events the summary skips. Both engines then name the read. Read
  [engine-mapping.md](./engine-mapping.md#forced-layout-blame-differs-by-engine) before touching or
  trusting this path.
- This lane runs inside the gecko pass (one browser launch yields both the CPU samples and the
  markers), which is **not optional**: without it a Firefox recording would report every rendering
  count as 0 — indistinguishable from a clean run — so there is no flag to turn the gecko pass off on
  this lane (the CLI keeps the profiler on for every firefox rung). Both `query cpu` (self-time on the
  forcing frame) and
  `query blame --forced` (the read-site samples) name the read on this lane; see
  [cpu-profiling.md](./cpu-profiling.md#what-self-time-actually-includes).

## What is NOT measured on Firefox (reported honestly, never as fake zeros)

Paint counts (off-main-thread here), invalidation tracking + rollup, long-task attribution (all
trace-derived on Chrome, and Gecko has no DevTools trace), and CPU/network throttling. `meta.notes`
and the terminal report say so; `assert` on those metrics fails rather than passing on a fake 0.
Layout/style/forced counts ARE measured, from the Reflow/Styles markers (above); they are
approximate (Gecko batches differently), so read them against another Firefox run, never Chrome's.

**INP is not on this list**: it never came from CDP, so it works here (see the BiDi section above).
Its honest caveat is a different one -- the number is real in both engines but not interchangeable
between them, because presentation delay is engine-specific. Under-claiming a metric wpd does
measure is the same failure as faking a zero, in the opposite direction.

**A third category exists and is the dangerous one: measured, but not meaning what it looks like.**
A fake zero announces itself; these do not.

- `forcedLayoutMs` **under-reports badly** on Firefox: 1.08ms vs chrome's 7.17ms for identical work
  on `examples/forces-layout.mjs`. The markers miss short flushes. It is invisible in the output:
  not a zero, so it never trips the "unmeasured" guard, and `meta.notes` covers what is missing, not
  what is subtly off.
- `query blame --forced` names the **read** on both engines, but Firefox's is a **sampled** estimate
  (it can lag one statement or miss a cheap read) where Chrome's comes exact from the `.stack`. The
  blame output discloses the sampled caveat, so this one is not silent.
- The signal that *does* survive cross-engine is CPU self-time (8.41ms chrome / 8.79ms firefox,
  ~5%), which is the inverse of how the README ranks trust. See
  [engine-mapping.md](./engine-mapping.md#what-is-actually-comparable-across-engines).
