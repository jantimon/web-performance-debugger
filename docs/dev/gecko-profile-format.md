# Firefox backend: Gecko profile format notes (internal)

> **Developer notes, not user documentation.** Nothing here is needed to *use* wpd; if you are
> looking for how to run the tool, read the [README](../../README.md). This file records the
> empirically-verified Gecko profile format facts that `src/profile/gecko.ts` depends on, for
> whoever has to touch that code next (e.g. when a Firefox update bumps the format version).

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
  So: no CDP counters, no DevTools trace, no CPU/network throttling, no invalidationTracking.
  Every CDP touchpoint is capability-gated behind `capsFor(browser).cdpCounts/trace/throttle`.
- `PerformanceObserver({ type: "event" })` `.observe()` does **not** throw, but Firefox does not
  populate Event Timing entries, so per-step INP stays `null`. Degrades cleanly (the driver's
  existing null handling already covers it).

## Gecko profiler via env vars (verified)

Started at launch and dumped on browser exit via `launch({ env })`:

- `MOZ_PROFILER_STARTUP=1`
- `MOZ_PROFILER_SHUTDOWN=<abs path>` (JSON written on `browser.close()`)
- `MOZ_PROFILER_STARTUP_FEATURES=js` (sufficient: gives JS stacks, UserTiming markers, and
  Reflow/Styles markers with JS cause stacks. `stackwalk` not needed and would only add native
  C++ frames we collapse anyway.)
- `MOZ_PROFILER_STARTUP_INTERVAL=1` (ms floor; the real sample delta measured was ~1ms median)
- `MOZ_PROFILER_STARTUP_ENTRIES=16000000` (big ring buffer so the window is not overwritten)

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

## Stretch goal: Reflow/Styles markers -> layout/style blame (landed)

- Marker names: `"Styles"` (style recalc, phase 1 interval) and `"Reflow (sync)"` /
  `"Reflow (interruptible)"` (phase 2/3 start/end pairs). Category 3 = Layout.
- **Cause stacks are real and resolvable.** A marker's `data.stack` is an embedded thread-shaped
  object whose `samples.data[0][0]` is a **stack index into the SAME host thread's stackTable**
  (not a self-contained mini-profile). We resolve it through the identical frame path as samples.
  When a synchronous reflow/style flush is triggered from JS, the cause chain contains the JS
  frames (verified: our forced `offsetHeight` probe produced a `Styles` marker whose cause chain
  was `Node.appendChild -> http://.../__blank__:1:8`). We map `Styles -> style`, `Reflow* ->
  layout`, set `event.at` from the top JS cause frame, and set `forced: true` when a JS frame is on
  the cause stack (same "JS on the stack == synchronously forced" approximation as the Chrome
  trace path). Markers with a native-only cause get counts + durations but no `at`/`forced`.
- This lane runs only inside the `--cpu-profile` gecko pass (one browser launch yields both the CPU
  samples and the markers). Without `--cpu-profile`, a Firefox recording is timing-only with honest
  `meta.notes` saying rendering detail is not collected.

## What is NOT measured on Firefox (reported honestly, never as fake zeros)

CDP counters (exact layout/style/script counts), paint counts, invalidation tracking + rollup,
long-task attribution from a DevTools trace, CPU/network throttling, and INP. `meta.notes` and the
terminal report say so; `assert` on those metrics fails rather than passing on a fake 0.
