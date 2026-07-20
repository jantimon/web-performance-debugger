# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`wpd` (package `@jantimon/web-performance-debugger`, bins `wpd` / `web-performance-debugger`) is a
TypeScript CLI that drives Chrome or Firefox via Puppeteer to **attribute layout/paint/style/
invalidation work back to source lines**, plus **CPU sampling** (on by default) that attributes
self-time to source/package. One user-facing axis picks where it runs: `--target chrome|firefox|node`.
Trust tiers, keep them straight: **counts** (trace-derived, windowed to the renderer main thread) are
exact; **slice ms** on a `--breakdown` bar and **wall/INP** are wall-tier directional (trace
`base::TimeTicks` / Chrome-clamped `performance.now()`); **CPU self-time** comes from the profiler's
own microsecond clock (*not* `performance.now()`), so its ms are a real signal, trustworthy in
aggregate (sampling noise ~few %). So it is not a wall-clock benchmark runner, but it *is* the right
tool for comparing JS cost (e.g. SSR `renderToString` lanes).

**`selfMs` is not "pure JS" on the browser lanes.** It is JS *plus the synchronous engine work JS
triggered*: a forced layout lands as self-time on the line that forced it (measured: ~85% of the
forced-layout probe's "JS" self-time is reflow). Only `--target node` (no DOM) measures pure JS.
This is a feature — it prices "delete this line" — but do not describe it as pure JS.

Read `README.md` for the user-facing surface; this file is the internal map; **`docs/dev/` holds the
measured facts behind the non-obvious choices** ([index](docs/dev/README.md)) and is the first stop
before changing the rung ladder, the Gecko converter, or any cross-engine claim.

## Commands

```bash
npm run build           # tsc -> dist/ (ESM, NodeNext)
npm test                # unit only (pretest builds first); pure functions, no browser
npm run test:e2e        # e2e: drives the real CLI against headless Chrome (record -> query)
npm run lint            # oxlint src   (lint:fix to autofix)
npm run format          # oxfmt --write (format:check to verify; config in .oxfmtrc.json, ~prettier)
node dist/cli.js <...>  # run the CLI (installed bins: web-performance-debugger, wpd)
npm run changeset       # add a changeset; CI Release workflow versions+publishes on merge to main
```

CI (`.github/workflows/ci.yml`) has two jobs on Node 24: `ci` (lint → format:check → build →
unit `test`, browser-free, `PUPPETEER_SKIP_DOWNLOAD`) and `e2e` (downloads Chrome, runs
`test:e2e`). The **306** unit tests (`test/unit/*.test.mjs`) cover pure functions against compiled
`dist/` (classify/summarize/analysis/format, plus the breakdown engine, `query spans` adapter + its
flood filter, the `query span` anatomy + removed-verb stubs, the thrash detector, the firefox
dirtied-by report, the gecko converter, the XDG pointer, frame side track, the trace-overflow/partial
notes, the LoAF shaper (`summarizeLoaf`), and the `facts.md` ledger drift check). The **34** cli e2e tests (`test/cli.e2e.test.mjs`) spawn the
built CLI against real headless Chrome: forced-layout `blame`, CPU source resolution, the
`--breakdown` reconciling spans (incl. an idle-dominated span and a user `performance.measure`),
`query spans` (incl. the `--min-wall`/`--filter` flood filter), `query span` (a run span's bar + hot
functions, a --deep step's counts + forced), per-step LoAF script attribution on the default rung,
`waitForStable` catching a streamed transition, `--keep-partial` salvage, the
digest/index removal, the frame side track, and the two-capture assert workflow (a forced budget on
`--breakdown` and a slice budget on `--deep` each fail loudly). They **self-skip when Chrome is not installed** (so
`npm test` and the `ci` job stay green and fast); `WPD_E2E_REQUIRED=1` (set by `test:e2e`) turns a
missing browser into a hard failure so the e2e job can't silently pass. **11** firefox e2e tests
(`test/firefox.e2e.test.mjs`, self-skipping) cover the gecko lane end-to-end.
The broader smoke tests below stay manual (always `npm run build` first — the CLI runs `dist/`):

```bash
node dist/cli.js record examples/forces-layout.mjs --bench --iterations 5  # in-page; forced-layout detection
node dist/cli.js query blame latest --forced                        # source-attributed thrashing
node dist/cli.js record examples/counter-steps.mjs --url examples/react-counter/dist/index.html  # driver (default)
node dist/cli.js query spans latest                                 # per-span overview (run + steps)
node dist/cli.js query span latest "add rows"                       # one span's full anatomy
# examples/react-counter is a Vite app: cd examples/react-counter && npm install && npm run build (needed once for --url)
```

## Architecture

Flow: **`record` produces a `Recording` (model/recording.ts) → `query`/`assert`/`diff` consume it.**
`src/cli.ts` (commander) is the only entry point and wires every command. The model is split across
`model/`: `recording.ts` (the `Recording`/`EventKind`/`Breakdown` types), `marks.ts` (the `wpd:*`
mark namespace), `time.ts` (clock/us↔ms helpers), `measured.ts` (the `Measured<T>` not-measured-vs-0
honesty wrapper), `reconcile.ts` (slice-sum-vs-wall residual), `span-merge.ts`
(`mergeSpanOccurrences`: collapse a repeated `measure` label to its lower-median-by-wall occurrence,
verbatim), `span.ts`/`spans.ts` (the stored `Span` count projection + the `query spans` adapter),
`rung.ts` (rung/passes predicates like `isFirefoxDeep`/`isGeckoRung`), `artifact.ts` (the
schema-version + recording-shape gates every reader passes through), `query.ts` (the derived view
shapes the `query`/`cpu-diff` verbs emit under `--format json|toon`, kept off the stored types so the
JSON contract cannot silently drift), and `compat.ts` (`comparabilityMismatches`: the capture axes
that make a `diff`/`cpu-diff` `--fail-on-regression` gate meaningless, so it refuses instead of
fabricating a pass/fail). `record` orchestration lives in
`src/record/`: `capture.ts` (`captureFor` picks the ONE capture rung + `capabilitiesFor`/
`blameSemanticFor`/`countScopeNote`), `page-option.ts` (`PageResolution`: resolves the `--url <value>`
host page, or its hidden `--html` alias, to a live URL to navigate or a local HTML file to serve),
`runpass.ts` (runs that one capture), `artifacts.ts`
(serialization), `spans-build.ts` (assembles `Span[]` from the run/steps/summary), `breakdown-spans.ts`
(per-span bar assembly, FIFO measure pairing, then `mergeSpanOccurrences`), and `notes.ts`
(`meta.notes`).

### Two execution modes (this is the central design fork)

`record` has two fundamentally different ways to run the user's module, with **different `run`
contracts** — keep them straight:

- **Driver mode** (default): the module runs *in Node* and `run({ page, ctx, measureStep })`
  drives the page via Puppeteer. Implemented by `browser/driver.ts`. Steps are defined by
  `measureStep(label, action, { until })`; each becomes a `kind: "step"` span on the one recording.
  Per-step INP is captured via an injected Event Timing `PerformanceObserver`, and per-step Long
  Animation Frames via an injected `long-animation-frame` observer (`summarizeLoaf` -> `Span.loaf`,
  Chrome-only, ungated by any capture cap, so it attributes a step's slow frames to scripts even on
  the default rung). Both observers are in-page, not CDP. `browser/until.ts` `waitForStable` is an
  opt-in `until` for streamed/soft navigations the default settle ends before. A
  `page.goto` inside a `measureStep` is traced, so a navigation step measures a cold boot.
- **Bench mode** (`--bench`): the module is served over http and `import()`'d *inside the
  browser*; `run(ctx)` gets no `page` handle (there is nothing to drive from inside) but has live
  `document`/`window`, and `--html`/`--url` still supply the host page. Implemented by
  `browser/harness.ts` (a function serialized into `page.evaluate`) + `browser/server.ts` (a
  temp static server — ESM `import()` can't use `file://`, and the blank host page is served
  same-origin to avoid cross-origin import). It measures only `run()` (page load/boot is
  excluded). The CLI sets the internal `RecordOptions.driver` to `!bench`.

`--iterations`/`--warmup` repeat `run()` in **both** modes: the mode that measures real interactions
needs a statistical footing as much as bench does. Driver labels are unique **within an iteration**,
not within the run: the repetitions are a label's samples, so
`mergeSteps` groups by label and each step reports the median of its own. That is also why
`DriverStep` carries `markIndex` separately from `index` -- the trace needs a name that is unique
per pass, while `index` is the step's stable position within an iteration.

Modules/HTML must live under the cwd (the static server is rooted there). `--url` names the host page
(a live URL or a local HTML file, `page-option.ts`); `--html` is its hidden alias. A module + `--url`
runs the module against that host; a module + no `--url` runs it against a blank page. **No module +
`--url` is the zero-authoring on-ramp**: the built-in load flow navigates to the target inside one
`"load"` step and settles, so the recorded window is the page's own cold boot (`runpass.ts`,
`driver.ts`). No module and no `--url` errors.

`browser/launch.ts` launches Chrome **sandboxed by default**; a sandbox startup failure is re-thrown
as guidance naming the opt-in (`--disable-browser-sandbox`, for containers/restricted CI), never a
silent unsandboxed retry (`isSandboxLaunchError`/`sandboxLaunchError`). A transient cross-process boot
failure (`net::ERR_INVALID_HANDLE`, "detached Frame", common on a heavy `--url` boot) IS retried, on a
fresh browser, up to a bounded limit (`retryTransientNav`); `notes.ts` records that the numbers are
from the successful attempt.

### One capture per run: the rung ladder (why numbers are trustworthy)

Every invocation is **exactly one capture pass** — one browser launch, one run of the flow, one
recording. `record/capture.ts` `captureFor(opts, browser)` picks the ONE `CaptureConfig` (categories,
cpu on/off, keepThreadIds, gecko) from the flags; there is no multi-pass plan and no pass windowing.
`meta.passes` is a single-element array naming the rung. The chrome rungs:

- **default** (no flag) — `categories: null` (no trace), CPU sampler on. The four-slice CPU bar, no
  rendering counts, cleanest wall (~1%).
- **`--breakdown`** — light trace (`breakdownTraceCategories()`: the shipped set MINUS `.stack`, MINUS
  `invalidationTracking`, plus gc, `keepThreadIds` on) fused with the sampler. `trace/breakdown.ts`
  tiles the reconciling `js·style·layout·paint·gc·other·idle` bar per span, and layout/style/paint
  counts come out exact. Cannot report forced counts/blame (needs `.stack`).
- **`--deep`** — full trace (`.stack` + `invalidationTracking`), sampler OFF. The attribution report:
  forced-by read-sites, dirtied-by writes, the thrash detector, invalidation rollup, exact counts,
  long tasks. No CPU model, and slice DURATIONS are suppressed (see below).
- **`--precise-wall`** — default rung minus the sampler: a pristine benchmark wall, nothing else.

Firefox is one gecko pass at every rung (`gecko`/`gecko-deep`); node is the in-process `node-cpu`
lane. The rungs are mutually exclusive (`--breakdown --deep` is rejected: two questions, two
invocations), and the CLI rejects `--breakdown`/`--precise-wall` on firefox/node.

**Why the split, present-tense [measured] constraints** (docs/dev/cpu-profiling.md):

- **The CPU sampler must NEVER ride a `.stack` trace.** `disabled-by-default-devtools.timeline.stack`
  makes Blink walk the JS stack on every Layout, and the sampler bills that walk to the JS frame that
  forced the layout — the same frame the real forced-layout cost lands on, inflating self-time
  **+21%**. So the sampler rides only the light no-`.stack` trace (`--breakdown`) or no trace
  (default); `--deep`, which needs `.stack`, runs the sampler OFF.
- **The light `--breakdown` trace costs ~2-5% wall** over sampler-only and leaves sampled self-time
  clean (+0-1%), which is why one fused pass is honest.
- **`--deep` suppresses slice ms.** The `.stack` trace inflates real style recalc up to **+38%**, so a
  `--deep` recording reports `layoutMs`/`styleMs`/`paintMs` and any bar as `null` (`durations: false`
  in `capabilitiesFor`); it leads with identities + exact counts, and shows span wall (honest window
  width) only.

**Counts are trace-derived, main-thread windowed.** There are no CDP/`getMetrics` counters (`cdp.ts`
holds only the profiler calls). `metrics/summarize.ts` sums `Layout`/`UpdateLayoutTree`(-parse)/
`Paint` on the renderer main-thread pid/tid the breakdown bar tiles (`trace/main-thread.ts`), which
reproduces the top-process scope (an OOPIF's own-process count is a separate off-thread count,
never summed). A `--url` boot navigates the blank host page to the target on a NEW renderer process,
so `wpd:run:start` lands on the pre-navigation renderer; `main-thread.ts` **re-anchors** to the thread
that carried the post-navigation work (and `notes.ts` says the counts describe the loaded page, not
the blank host). `layoutMs`/`styleMs`/`paintMs` are now **wall-tier** trace `base::TimeTicks` ms (~1%
directional), valid only on the light trace. Because every invocation is one pass that runs every
iteration for the wall samples, a counting rung's counts **total across `--iterations`**
(`countScopeNote` says so); a driver step's counts window to iteration 0 (`labelWindows`), so per-step
counts stay one iteration's work. Bench `wallMs` is the **sum of the timed samples**, not a window.

**The artifact is one file (schema 3).** `Recording` = the run summary + the collapsed `Span[]` (the
run window, each driver step, and every user `performance.measure`) + meta. Siblings: the raw
`.cpuprofile` and the resolved `.cpu.json` `CpuModel`. The classified `events[]` DEEP EVENT LOG is
written INTO the recording only under `--deep` (chrome) and firefox — every other rung leaves it
empty, which keeps the default artifact digest-sized. `model/artifact.ts` REJECTS any artifact whose
`meta.schemaVersion !== SCHEMA_VERSION` with a re-record message rather than mis-parsing it. A
`measure` label emitted every `--iteration` recurs, and `mergeSpanOccurrences` reports the
lower-median-by-wall occurrence VERBATIM (`aggregation: "median"`, `samples`, `wallMin/MaxMs`), never
a per-slice average, so the bar stays a real reconciling sample.

### Trace pipeline (trace/)

`parse.ts` (raw trace JSON → `NormalizedEvent[]`, `findWindow`/`findSteps` locate
`wpd:run`/`:step:N` marker windows; `keepThreadIds` keeps `pid/tid` for the breakdown pass only) →
`classify.ts` (event name/category → `EventKind`:
layout/style/paint/composite/invalidation/scripting/gc/task/usertiming/other) → `stacks.ts`
(rewrites trace stack URLs back to local source paths; **async** because it resolves bundle
frames through sourcemaps via `sourcemap.ts`) → `analysis.ts` (`markForced`, `forcedLayouts`,
`longTasks`, `extractInvalidations`). Alongside: `taxonomy.ts` (the `EventKind` → work-slice map
and paint classification), `main-thread.ts` (picks the renderer main-thread `pid/tid` the counts and
the bar share), `steps.ts` (per-step windowing/merge), `frames.ts` (the off-thread frame side track
parsed from the already-enabled `devtools.timeline.frame` category — display-only,
[rendering-counts.md](docs/dev/rendering-counts.md)), and `breakdown.ts` (the `--breakdown` engine:
`(trace events, profile samples, window) → Breakdown`, disjoint main-thread self-time tiled
`js/style/layout/paint/gc/other`, `idle := window − Σ`).

**The `--deep` attribution pipeline** reads the full-trace event log two ways. `thrash.ts`
(`analyzeThrash`) is the chrome dual annotation: per top-level task in `ts` order, it pairs each
forced flush (a `layout`/`style` event with a resolved read-site `.stack`) with the WRITE(s) that
dirtied it since the last flush (the `invalidationTracking` records), matching invalidation kind to
flush kind ([measured] 42 of 43 forced flushes on the probe). It yields both the per-read `dirtiedBy`
map (surfaced under `query blame --forced` and `query span`) and the `ThrashReport` interleave
(write→read→write→read, the run-span thrash count). `firefox-dirtied.ts` (`firefoxDirtiedBy`) is the
firefox `--deep` counterpart: Gecko cause stacks carry the write natively but only the FIRST
invalidation since the last flush, so it emits a `first-invalidation` `DirtiedByWriteRollup` (no
forced-by, no thrash — engine-mapping.md's never-fake-parity rule), reachable via `query blame
--dirtied`.

**Forced-reflow detection** is the key feature and depends on a non-obvious config: layout/style
events only carry a JS stack when JS forced them synchronously, and capturing that stack requires
the `disabled-by-default-devtools.timeline.stack` category in `trace/categories.ts`. `markForced`
flags layout/style events that have a resolved user stack (`e.at`).

Two things this rule is **not**, both documented in
[docs/dev/engine-mapping.md](docs/dev/engine-mapping.md):

- **Not DevTools' rule.** DevTools ignores the stack entirely and requires nesting inside a JS
  invocation event *plus* a >=30ms per-task aggregate. Ours flags cheap forced layouts DevTools
  stays silent on — defensible for a CI gate, but do not describe it as "what DevTools does".
- **Firefox reaches the same read site by a different route.** Chrome's `.stack` names the geometry
  **read** at the flush. Firefox has no such stack, so `query blame --forced` samples it: a
  DOM-accessor label frame over a Layout-category flush, attributed to the nearest JS ancestor's
  executing line + the property name. Same read-site semantic, comparable at line granularity, but a
  sampled estimate (cheap reads can be missed, the line can lag one statement). Gecko's marker
  **cause** stack names the **write** instead, so it is kept off `blame` (reachable via `query get`
  under `args.data.invalidationStack`), never the `--forced` answer.

### Output & consumption

- `metrics/summarize.ts` builds `RecordingSummary` from trace events alone (counts main-thread
  windowed, durations wall-tier on the light trace, `Measured` null where the rung observed nothing).
- `commands/query.ts` = 6 verbs: `spans`, `span`, `events`, `blame`, `get`, and the `--dirtied` mode
  of `blame` (plus `cpu`/`frame` in `commands/cpu.ts`). `query spans` (via `model/spans.ts`) is the
  compact **overview**: a read-only OUTPUT ADAPTER that folds whatever bar a recording already holds
  (seven-slice `SpanBreakdown` or four/six-slice `CpuBreakdown`) onto one `UnifiedSlices` shape — no
  new stored type — surfacing each span's `aggregation` (`first`/`sum`/`median`) and, for a merged
  measure, its `samples`/wall spread. **`query span <label>`** is the drill-in: one span's full
  anatomy (bar, wall/aggregation/spread, Measured counts, INP/interaction, the forced read-sites +
  dirtied-by writes + thrash rollup an event-log rung carries, and per-span hot functions on the
  CPU-sampler scripting axis — the run span from the sibling CpuModel, a `--breakdown` chrome
  step/measure or firefox measure span from stored top-K `SpanHot` refs joined to the model by id
  (`profile/span-hot.ts`; MEASURE-pooled, share-denominated, floor-suppressed, never the bar's `js`
  slice — docs/dev/cpu-profiling.md)). `<label>` is a bare label or a `kind:label` qualifier — span identity is
  kind+label, so a bare label matching more than one kind is a collision the caller resolves.
  **Agents/users should read `query spans` then drill with `query span`/`query get <id>`, not the
  multi-MB recording.** `assert.ts` gates the exact count thresholds (recording *or* per-step via the
  step spans in `model/step-view.ts`) AND per-slice budgets (`--max-slice <name>=<ms>`, parsed by
  `model/spans.ts` `parseSliceBudgets`, gating a target span's reconciling-bar slice ms; a slice the
  rung did not measure is a loud `n/a` FAIL, never a silent pass). `diff.ts` compares two recordings:
  the gated exact-count deltas plus advisory per-span slice-ms deltas (`diffSpanSlices`), matched by
  `kind:label`, with comparability warnings when a metric is measured on one side only.
- `commands/resolve.ts`: the `latest` keyword resolves via a **cwd-keyed** pointer file under the XDG
  state dir (`$XDG_STATE_HOME/wpd/pointers/<hash>.json`, else `~/.local/state/wpd/pointers/`) that
  `record` writes — so no `recordings/` dir is dropped into a consumer's cwd. A legacy in-cwd
  `recordings/.wpd-last.json` is still READ as a fallback, never written. **Never resolve recordings
  by mtime**.
- `output/format.ts`: every output supports JSON or TOON (`--format toon`); recordings are
  read back auto-detecting the format. `output/ascii.ts`: terminal tables/sparklines (ANSI-aware:
  widths are measured by *visible* length via `output/color.ts`'s `visibleLength`, so colored cells
  stay aligned). `output/color.ts`: TTY-aware ANSI helpers; **disabled by default** (the library
  stays plain when called directly, so unit tests and programmatic/agent use get no escape codes).
  Only `cli.ts` opts in, via a `preAction` hook resolving the global `--color auto|always|never`
  (auto = `isTTY && !NO_COLOR`). Structured `--json`/`--format` output never calls the helpers, so it
  is plain regardless. Color lives only in the human report/table builders (`commands/cpu.ts`,
  `commands/record.ts`): heat-colored `self %`, cyan packages, dimmed paths/source/secondary counts,
  bold headline numbers.

### CPU profiling (on by default on the sampler rungs; `--precise-wall` opts out)

For JS cost (render/reconcile/hot loops), the V8 sampling profiler runs via CDP
`Profiler.start/stop` (`metrics/cdp.ts`, the only calls left there), bracketed around the timed
window. It rides the ONE capture rung (default or `--breakdown`), never a pass of its own; it costs
~1% on wall on the default rung, which `--precise-wall` buys back. It is OFF on `--deep` (the sampler
cannot ride a `.stack` trace, +21%). `profile/cpuprofile.ts` turns the raw `.cpuprofile` into a
**resolved, self-contained `CpuModel`**
(per-function self/total time + a thresholded call graph), reusing `makeSourceResolver` +
`SourceMapResolver` for source attribution. Self time rolls up by **package** (`packageRollup`,
pnpm-safe: last `node_modules/<pkg>` segment, and monorepo workspace packages via nearest
`package.json` name) or **file** (`fileRollup`); `query cpu --by package|file|function` picks the
lens. Two files are written: the raw
`.cpuprofile` (DevTools/Speedscope) and `<base>.cpu.json` (the model, read by the verbs). Resolution
happens at record time because the served-server URL is ephemeral; the model is sized by function
count, not sample count. Verbs: `query cpu` (bounded overview), `query frame <id>` (callers/callees
from the model's edges), `cpu-diff` (per-function/per-module self-time deltas, noise-filtered).
Non-obvious: CDP callFrame line/column are **0-based** (converted to 1-based in `resolveCallFrame`,
unlike the 1-based trace stack frames); puppeteer harness frames are dropped via `isToolFrameUrl`.
`SourceMapResolver` handles three map sources: local sidecar `.map`, inline data-URI, and **remote**
(for `--url` sites, `frame.remote` set in `makeSourceResolver`) by fetching the script, reading its
`sourceMappingURL` **or its `SourceMap`/`X-SourceMap` response header** (production builds often
strip the comment and keep the header), and fetching the map (5s timeout). Minification is
irrelevant once the map resolves: a minified single bundle splits per package normally.
**ONE resolver per run**, constructed in `record()` and threaded through `runPass` ->
`attachStacks` (x2) and `buildCpuModel` (both take it as an optional param defaulting to a fresh
instance, so `runtime/node.ts` and programmatic callers are unaffected): it shares the cache (a
remote script+map is fetched once, not once per pass) and, critically, the **diagnostics**. Every
`loadMap` attempt records an outcome (`no-sourcemap-url` / `script-fetch-failed` /
`map-fetch-failed` / `map-parse-failed`); `maps.diagnostics()` returns them grouped by reason.
Swallowing a failure (a bare `catch { return null }`) makes it invisible, which reads as "the
feature does not exist": frames keep minified names and the per-package rollup silently reports one
bundle-shaped bucket. So `record()` mutates `meta.sourcemaps` + pushes a note (WARNING only when 0
of N resolved) **after** `buildCpuModel` but **before** any artifact is serialized -- that ordering
is load-bearing, since `meta` is shared by reference with every artifact. An unmapped remote frame
buckets by **origin** (`(cdn.example.com)`), never `"app"`: blaming unmapped third-party code on the
user's own bundle is exactly the mis-attribution `classifyPseudoUrl` already guards against. Local
source paths are resolved with a `/private` symlink fallback (`resolveOriginalSource`) because
bundlers record sources against the symlinked cwd while Node canonicalizes it; remote frames get
string-based package attribution (no fs). Resolved local source paths (`event.at`/`stack[].source` and cpu
`source`/`file`) are stored **relative to root** via `relativizeSource` *after* fs-dependent
resolution: smaller files, portable recordings, and stable `cpu-diff`/`functionJoinKey` joins across
machines (the `/private` mismatch stops breaking joins). `node:` builtins, remote urls, and paths
outside root stay absolute; artifact back-pointers (`recording`/`profile`, the `latest`
pointer) stay absolute for cwd-independent re-opening -- but the terminal report prints them through
`displayPath` (relative to cwd when shorter). Display and storage answer different questions: stored
absolute so any cwd can reopen them, shown relative because an absolute path is noise to read and
puts your home directory into every pasted report, screenshot and recorded terminal. On-disk numbers are rounded to 4 decimals in
`serialize` (drops binary-float dust; the raw `.cpuprofile` is written via direct `JSON.stringify`
and stays exact). Display names prefer the sourcemap's original identifier (`pos.name`)
over the minified V8 name (kept as `CpuFunction.minified`), which also makes `cpu-diff` join stably
across different minified builds.

**Node runtime (`--target node`)**: a CPU-only lane that skips Chrome entirely. `runtime/node.ts`
(`recordNode`) imports the module *in this process* and profiles `run()` with node's built-in
`inspector` Session (`Profiler.start/stop` returns the same `RawCpuProfile` shape as CDP), bracketed
around the timed loop so only `run()` + callees are sampled. It reuses `buildCpuModel` unchanged via
`{ runtime: "node" }`, which swaps `makeSourceResolver` for `makeNodeSourceResolver` (rewrites
`file://` frames to local paths; `node:` builtins fall to the `(node)` package bucket in
`resolveCallFrame`). The tool's own loop frames are dropped by extending `isToolFrameUrl` to match
`/runtime/node.`. CPU-only means no Recording rendering counts: `recordAndReport` dispatches to
`recordNode` + `printNodeReport` (CPU headline + per-iteration timing, no DOM tables). The CLI sets
`runtime: "node"` from `--target node` and errors on browser-only flags (`--url/--html/...`).
`meta.runtime` records the lane; `meta.passes` is `["node-cpu"]`.

**Firefox backend (`--target firefox`)**: a second browser lane driven over WebDriver BiDi (no
CDP). `browser/backend.ts` `capsFor()` is a plain caps object (`cdpCounts/trace/throttle/
cpuProfile/geckoProfiler`) so `runPass` stays one function with capability guards, not a class
tree. `browser/launch.ts` returns `client: CDPSession | null` (null on firefox); every CDP call
site (throttle/`page.tracing`/`startCpuProfile`) is gated by the caps or a null check (never
`client!`), and `runDriver` takes a nullable client (per-step `cdpDelta` becomes `{}`). Firefox has
**no** CDP trace, invalidationTracking, or throttling; the CLI errors on `--breakdown`/`--precise-wall`/
`--cpu-throttle` and `meta.notes` says so loudly (never fake zeros). **INP is NOT in that list** — it
never came from CDP, it is an in-page Event Timing observer in `driver.ts`, ungated by caps, and it
works. `meta.browser` is `"firefox"` (absent = chrome, so old recordings stay valid).

The lane is ONE gecko pass at every rung (`captureFor` returns `rung: "gecko"`, or `"gecko-deep"` when
`--deep` requests the dirtied-by write report — same capture, a reporting tier over it). The CLI
refuses to turn the profiler off here, because the gecko pass is this lane's *only* source of CPU
samples, layout/style markers, the reconciling bar, AND read-site blame — without it a firefox
recording would report every rendering count as 0. The **gecko pass** launches Firefox with the Gecko
profiler env vars, runs the flow, closes the browser (which flushes a shutdown dump), then
`waitForGeckoDump` polls the file to stable before parsing. The dump stays a **path** on `PassResult`
(never a retained string) and is `copyFile`d to the artifact: a 16M-entry ring buffer serializes to a
very large file (16MB+ even for a trivial probe). The internal sampler interval
(`DEFAULT_CPU_INTERVAL_US`) is converted to Gecko's ms and clamped up to `GECKO_MIN_INTERVAL_MS`;
`sampleIntervalUs` is read back from the dump's `meta.interval` (what the sampler *actually* ran at),
never hardcoded.

`profile/gecko.ts` converts the raw dump (v34) to a standard `RawCpuProfile` fed to `buildCpuModel`
unchanged, plus `NormalizedEvent[]`: Reflow/Styles markers (kind layout/style, `forced` from a JS
cause, driving the flush COUNTS) and **sampled read-site blame events** (`sampled:true`, the
read line + property, driving `blame --forced`; `summarize` skips them so they never double-count a
flush). One gecko pass thus yields CPU + blame. Launched with `MOZ_PROFILER_STARTUP_FEATURES=js,cpu`:
the `cpu` feature populates the per-sample `threadCPUDelta` column, whose ~0 values are the honest
`idle` signal `computeGeckoCpuBreakdown` (`profile/gecko-breakdown.ts`) tiles into a
`js·style·layout·browser·gc·idle` bar (style/layout from the sampled Layout-category frame). Firefox
`performance.measure` spans (from UserTiming interval markers) become per-span `Span`s carrying a
`breakdown`, and a label repeated across `--iterations` is collapsed by the same `mergeSpanOccurrences`
the chrome lane uses (lower-median-by-wall occurrence, verbatim). Under `--deep`, `firefox-dirtied.ts`
reads the Reflow/Styles marker cause stacks into the first-invalidation dirtied-by report. `parseGecko`
**throws** on a missing `JavaScript` category or an empty thread
list: both would otherwise yield an empty-but-valid model reporting ~0 scripting time, the fake zero
this lane refuses to emit. `isToolFrameUrl` also drops `/__wpd_blank__` (BiDi attributes bench
harness frames to the served host page). Fixture: a trimmed real dump at
`test/fixtures/gecko-shutdown.trimmed.json`; e2e is self-skipping (`test/firefox.e2e.test.mjs`,
`npm run test:e2e:firefox`), NOT wired into `WPD_E2E_REQUIRED`.

**Before touching any of this, read [docs/dev/](docs/dev/README.md)** — the raw-format schemas, the
INP measurements, the Gecko<->Blink name map, and the honest caveats (Firefox `forcedLayoutMs`
under-reports ~7x from the markers; read-site blame is a sampled estimate that can lag one statement)
all live there with the probes that establish them.

## Conventions / gotchas

- ESM throughout: relative imports **must** use `.js` extensions in `.ts` source (NodeNext).
- Naming is standardized on **layout** (not "reflow") everywhere except the idiom *forced
  reflow*; **paint** (not "repaint"). Don't reintroduce the old names.
- The `EventKind` union (`model/recording.ts`, mapped by `classify.ts`), the `wpd:*` mark namespace
  (`model/marks.ts`), and the trace category list (`trace/categories.ts`) are the coupling points
  across files; change each in its one home.
- **No single-letter identifiers.** Locals, params, loop counters, `for...of`/`catch` bindings,
  destructured aliases, and sort-comparator params all get descriptive names (`event` not `e`,
  `group` not `g`, `frame` not `f`, `(left, right)` not `(a, b)`, `index` not `i`). This holds
  even inside browser-serialized functions (harness/driver/settle), where names don't affect
  serialization. Exported names, type names, and object property keys are exempt.
- **When more than one clock is in scope, a timestamp identifier names its clock** (`traceTs`,
  `pageNowMs`, `profileTs`), so a `* 1000` / `/ 1000` is never read for its direction. The unit
  conversions live in one place (`model/time.ts`: `usToMs`/`msToUs`/`cdpSecondsToMs`); use them
  rather than a bare factor.
- **No em-dashes or AI-prose in comments.** Use ASCII punctuation (`:`, `;`, `()`, `.`) and keep
  comments terse and technical; drop chatty tells (`à la`, `Best-guess`, `Nudge the engine`).
  The standalone `"—"` used as a missing-value placeholder in table *output* is allowed.
- **No hedging endcaps.** Do not append an unrequested caveat, counterargument, or moralizing endcap
  to a sharp claim in a comment or doc merely to demonstrate balance. If a boundary condition changes
  the truth of the claim, put it in the mechanism or scope the claim correctly. If it does not, cut
  it. Accuracy belongs in the argument; model self-protection does not.
- **No archeology.** Comments and docs describe the code as it is now, never how it used to be.
  Cut past-tense narration ("used to", "was null before", "until 0.5.0", "the bug this fixes",
  "measured before this was fixed"), version/PR numbers used as rationale, and incident logs.
  **Keep every `[measured]` number and the prohibition it justifies** -- those are why the code is
  the way it is -- but phrase them as present-tense constraints: "Never run the CPU sampler on a
  `.stack` trace: it inflates self-time +21%", not "it had its own pass until 0.5.0".
  The test: would someone implementing this from scratch today still write the sentence? If it only
  makes sense as "here is what we changed", it belongs in the changeset and the PR description,
  which is where history lives. This applies to `docs/dev/` too: state the finding, not its
  discovery story.
- Per the user's global rule: use `trash`, never `rm -rf`.
- **Commit messages carry no tooling attribution.** Do NOT append a `Co-Authored-By:` trailer, a
  `🤖 Generated with Claude Code` line, a `claude.ai/code/...` session link, or any similar
  advertisement to commit messages or PR bodies. Write the message as the change itself, nothing
  more.
- **Changesets are release notes, not design docs.** A changeset becomes a `CHANGELOG.md` entry read
  by someone deciding whether to upgrade: say what changed, what breaks, and what to do about it.
  Budget **~5 lines, ~15 for a breaking change**. The reasoning (why the bug existed, what was
  measured, what was ruled out) belongs in the PR description and the code comments, both of which
  outlive the changeset. Lead with **Breaking:** where it applies, and order a release's changesets
  breaking-first.
- **Cross-engine / profiling work**: `docs/dev/` ([index](docs/dev/README.md)) holds the measured
  facts the code depends on but cannot state itself. Read the relevant one BEFORE touching that
  code: `gecko-profile-format.md` (raw v34 schemas, marker phases, cause-stack encoding, line/col
  base) for the Gecko converter; `engine-mapping.md` (Gecko<->Blink names, blame semantics, what is
  actually comparable) before any cross-engine claim; `cpu-profiling.md` (the rung ladder, sampler
  contamination, what `selfMs` includes) before changing the rungs or the interval;
  `rendering-counts.md` (what each count counts, which ones reproduce, why there is no composite
  count) before adding a name to `classify.ts` or gating a count; `frame-floor.md` (the one-frame
  floor on `wall`/`INP`, and why the headless mode sets its height) before changing the headless
  option or adding a headless flag; `trace-buffer.md` (what raises the trace-buffer ceiling, what
  drops events, and the ~512MB parse limit) before changing `trace/tracing.ts` or the buffer size.
- **Claims about engine behaviour need a probe, not a mechanism.** A plausible mechanism is not
  evidence, however obviously true it reads: sourcemaps, INP, Gecko cause stacks and sampler
  isolation all behave in ways a mechanism alone predicts wrongly. Run `examples/forces-layout.mjs`
  in both engines and look at the output before writing the sentence (`docs/dev/README.md` has the
  rule and its corollaries).

## Regenerating the README demo (`examples/demo-gif/`)

The README hero is a [VHS](https://github.com/charmbracelet/vhs) terminal recording. The tape and a
how-to live in `examples/demo-gif/` (`demo.tape` + `README.md`); the rendered `demo.gif` is
git-ignored and hosted via a GitHub user-attachments URL (not committed, so the npm tarball stays
lean). **See `examples/demo-gif/README.md` for the render/publish steps.** Internal notes below.

What it shows: the `--target node` CPU lane attributing SSR `renderToString` self-time to
`react-dom` vs a styling library vs your component, down to a source line, via `query cpu`. It runs
**`examples/ssr-demo`** (in this repo, JSX-free so no build step): `react-dom` ~44% vs
`tailwind-merge` ~23% vs `wpd-ssr-demo` (your component) ~10%, with `tailwind-merge get
(lib/lru-cache.ts:35)` the single hottest function (~22%) as the punchline. Both the `record` and
`query cpu` output carry the four-slice CPU breakdown bar (`js · gc · native · idle`, node's engine
slice is `native`), and the `query cpu` headline names the per-iteration divisor (`summed over the
whole window across 250 iterations (divide by 250 ...)`), so the GIF shows the slice split and the
divisor alongside the package rollup.

**Keep this demo runnable from a clean checkout**; that property is the point, not the exact
percentages. A demo that depends on a pre-compiled bundle from a private repo can only be
re-rendered by one person on one machine, and rots unnoticed until the published GIF demonstrates a
flag that no longer exists.

Tape gotchas, if you tweak `demo.tape`:

- **`Sleep` must outlast the process.** VHS fires the next keystroke after the `Sleep`, not when
  the command exits. The `record` step needs a Sleep longer than its real runtime (~a few seconds).
- **`--iterations 250`** is about `(node) post (node:inspector)`, the profiler's own cost on this
  lane. It is a **fixed ~23ms** regardless of workload, so the only way to shrink it is more real
  work: at 80 iterations it is the single hottest function (~18-46%) and buries the punchline; at
  250 it drops to ~7% and `tailwind-merge get` takes the top row. If you shrink the workload, re-check
  that row before publishing.
- **`NODE_ENV=production` is load-bearing** (hidden in the tape). Without it React resolves to its
  development build: `react` outranks `react-dom`, and the profile shows a cost nobody ships.
- **`FontSize 18` + `Width 1580`**: the widest line is the `query cpu` iteration-divisor headline
  (~188 chars), which soft-wraps to two rows in the final frame at this width; the `record` report's
  dimmed Digest path no longer sets the width bound. Report paths still print relative to cwd
  (`displayPath`), which keeps the recorder's home directory out of the GIF (absolute paths wrap and
  leak it).
- The record output is wiped with a hidden `clear` before `query cpu` so the final frame focuses on
  the result alone.
- **Color is automatic**: VHS records in a real PTY, so `process.stdout.isTTY` is true and the
  default `--color auto` colorizes (heat-colored `self %`, cyan packages, dimmed paths/source/`fns`,
  bold headline). No flag in the tape, and real terminals get the same.
- The GIF (~300K) ships as-is; `gifsicle -O3` shrinks it losslessly if ever needed (WebP saved only
  ~10%, not worth a second artifact).
