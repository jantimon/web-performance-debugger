# @jantimon/web-performance-debugger

## 0.6.1

### Patch Changes

- 81f81b3: Recordings now disclose per-script sourcemap position misses. A map that LOADS fine but has no
  mapping for a queried line/col leaves that frame minified and origin-bucketed, invisible to the
  existing load-failure diagnostics. `meta.sourcemaps.positionMisses` now records hits vs misses per
  script, and a note names any script whose resolved map still dropped frames (honest counts, no
  fabricated cost). Firefox recordings also carry a forced-count comparability note: `forcedLayoutCount`
  comes from Gecko marker cause stacks (the write-site JS cause), not Chrome's read-site rule, so the
  count is not comparable across engines.
- 4bc0ab3: Fix: an unmapped CPU frame served from an ephemeral `127.0.0.1:<port>` origin no longer buckets by
  that port. A `--bench --url` run (or any local dev server on a `listen(0)` port) gets a new port
  every run, so a frame whose sourcemap loaded but position-missed landed under a fresh
  `(127.0.0.1:<port>)` "package" each time and split every cross-run `cpu-diff` / `functionJoinKey`
  join, including the `--breakdown` and firefox `jsByPackage` splits. Ports in the ephemeral range now
  drop out of the bucket (`(127.0.0.1)`); a registered port like `:3000` names a real service and
  stays. The trade: two different ephemeral-port origins on one host now share a bucket (and an
  ephemeral-port remote host loses its port), accepted so unmapped-frame joins survive a `listen(0)`
  re-pick. A frame from wpd's own served origin whose sourcemap points at an off-disk source resolves
  to the served file, or the stable `(served)` bucket.

## 0.6.0

### Minor Changes

- 4ccdbfc: **New: `--target firefox` gains the reconciling CPU-time breakdown bar.** The Gecko profiler now
  runs with `js,cpu`, so the per-sample CPU-usage signal drives an honest `idle` slice: the `record`
  report and `query cpu` show a `js · style · layout · browser · gc · idle` bar that tiles the sampled
  window exactly (style/layout from the sampled Layout-category frames). Paint stays a side track, not
  summed. A Gecko dump without the CPU signal (older recordings) still gets no bar rather than a
  fabricated idle.

  **New: `performance.measure` spans on Firefox.** Each user measure inside the run window appears in
  `recording.breakdowns` (kind `measure`) with its own reconciling breakdown.

  **Changed: `query blame --forced` on Firefox now names the READ site + the DOM property** (e.g.
  `offsetWidth`), sampled from the stacks, matching Chrome's flush-site semantics — the two engines'
  forced lines are now comparable at line granularity. `meta.blameSemantic` is `flush-site` on
  Firefox; the write/invalidation cause stays reachable via `query get`. Forced-layout counts still
  come from the Reflow/Styles markers. Requires nothing from users.

- 4ccdbfc: **New: a reconciling CPU-time breakdown bar, `js · browser · gc · idle`.** It tiles the sampled
  window exactly (the slices sum to wall, with `js` split by package) and appears in the `record`
  report, in `query cpu` (human and `--json`/`--format`), and as an additive optional `breakdown`
  field on the `.cpu.json` model. Firefox reports its own six-slice bar (`js · style · layout ·
browser · gc · idle`, see its changeset entry); `--target node` measures pure JS. Old `.cpu.json`
  files without the field keep working.
- 4ccdbfc: **New: `--breakdown` records a per-span off-thread frame side track (Chrome).** Each span now carries
  `frames` with the compositor's PipelineReporter verdicts: `presented` / `partial` / `dropped` /
  `no-update` counts, per-frame records, and the slowest presented (incl. partial) frame's top
  pipeline-stage durations. The `record` report and `query digest` print a compact line under each bar
  (`frames: N presented · N partial · N dropped`), and name any dropped or smoothness-affecting frame.

  This comes from data already in every Chrome trace (the enabled
  `disabled-by-default-devtools.timeline.frame` category); no trace-config change. It is DISPLAY-ONLY:
  frame counts are scheduler/settle noise (see docs/dev/rendering-counts.md), so `assert` and `diff`
  never gate on them; `Paint` stays the only exact rendering count. Nothing here is summed into a
  breakdown bar. Additive: recordings without the field still load.

- 4ccdbfc: **Changed: the `latest` pointer no longer writes a `recordings/` dir into your cwd.** It is now
  cwd-keyed and stored under `$XDG_STATE_HOME/wpd/pointers/` (falling back to `~/.local/state/wpd/`),
  so recording with `--out` elsewhere leaves the working tree untouched. `latest` still resolves from
  the cwd you recorded in, and an in-flight `recordings/.wpd-last.json` left by an older run is still
  read as a fallback.

  **Docs: pnpm install recipe.** pnpm 10+ blocks Puppeteer's browser-download postinstall (pnpm 11
  hard-fails `pnpm exec wpd`); the README now documents the `onlyBuiltDependencies` /
  `ignoredBuiltDependencies` recipes.

  **Changed: `query cpu` states the iteration divisor** in its header when `--iterations > 1` (the
  JS self-time headline is a whole-window total; divide by N for a per-iteration figure).

- a0e674b: **Breaking: `paintCount` counts main-thread paint only, so expect it to drop sharply.** It also
  summed raster-worker events, which made it swing 3->39 on identical work while `assert --max-paints`
  and `diff --fail-on-regression` gated CI on it. It is now exactly one per dirtied region (measured:
  N+1 for N regions, zero variance over 40 runs), so those gates mean something. Re-baseline any
  `--max-paints` threshold.

  **Breaking: `compositeCount` and `compositeMs` are gone.** They counted committed frames, so they
  tracked `--settle` duration (7x swing on unchanged work) rather than anything the page did. There is
  no replacement; read `paintCount`.

  **Breaking: a driver run reports no run-level `summary.wallMs` (it is `null`).** It was the trace
  pass's window: a single instrumented sample spanning prepare + every step + settle, sitting beside
  per-step medians from the clean pass and routinely ~2x from them. Per-step wall is unchanged in
  `summary.perStep` / `query index`; `assert --max-wall` against a driver recording now fails and
  points at the step index. `--bench` and `--target node` are unaffected.

- 4ccdbfc: **New: `query spans <file> [--label <L>]`: one unified per-span breakdown across every target.**
  Returns one entry per span (the run window, each driver step, and every user `performance.measure`)
  in a single slice shape (`js` with `byPackage`, `style`, `layout`, `paint`, `gc`, `other`, `idle`)
  whether the recording came from chrome `--breakdown`, `--target firefox`, or `--target node`. A
  slice a lane could not measure is an explicit `null`, never a fabricated `0`. `--label` filters to
  one span by exact label. It sources the recording's stored per-span bars when present, else
  synthesizes the `run` span from the CPU model's bar, so a recording carrying any bar is never empty.
  New public types `SpansResult` / `SpanEntry` / `UnifiedSlices`; `query cpu --json` on Firefox now
  hints at this surface. Each span declares `aggregation` (`"sum"` for the run window, `"first"` for a
  step or `performance.measure`) and `iterations`, so a consumer knows whether a span's numbers are a
  per-loop total or one iteration.
- 4ccdbfc: **New: `record --breakdown` (chrome), a reconciling seven-slice bar per span.** One fused pass (a
  light trace + the CPU sampler) produces `js (by package) · style · layout · paint · gc · other ·
idle` for the run window, each driver step, and every user `performance.measure` inside the run.
  Each bar tiles its window exactly (`Σ slices + idle = wall`); slices come from the trace, and the
  `js` split from the samples that land in its regions (proportions only). Stored additively as
  `Recording.breakdowns` and shown in the `record` report and `query digest`; old recordings keep
  loading. Forced-layout count and blame need the `.stack` category this mode drops, so they are
  reported as **not measured** (never 0) -- run the default mode for forced-layout blame.

  **New: `record --headless-mode new|shell` (chrome).** `shell` launches chrome-headless-shell, which
  runs frames at ~120Hz and halves the one-frame floor on `wall`/`INP` (16.6 -> 8.3ms). `shell` is the
  default; pass `--headless-mode new` to run the full-Chrome new headless (~60Hz) instead.

- 4ccdbfc: **Chrome now defaults to chrome-headless-shell (~120 Hz frames).** `wall`/`INP` read ~half of what
  they did on sub-frame work, so `assert --max-wall`/`--max-inp` thresholds tuned under the old default
  need re-tuning (or pass `--headless-mode new` to restore the old full-Chrome ~60 Hz cadence). Counts,
  forced-layout blame, and CPU self-time are unchanged. If chrome-headless-shell is not installed, the
  run falls back to new-headless with a warning instead of failing.

### Patch Changes

- de12174: **Fixed: `--protocol-timeout` now works on `--target firefox`.** Under load Firefox can fail to
  launch with `session.new timed out. Increase the 'protocolTimeout' setting` — advice you could not
  take, because the CLI rejected that flag on Firefox as CDP-only. It is not one: raise it when
  Firefox times out launching. That error no longer suggests measuring less work per step, which
  cannot help when the browser never started.

  **Fixed: `--bench`'s help said `run()` takes "no args", which reads as "no DOM".** It gets
  `run(ctx)`, with live `document`/`window`, and pairs with `--html`/`--url` for a host page. The
  README now says which mode to pick: `--bench` prices code the page runs, the driver measures a real
  interaction.

## 0.5.0

### Minor Changes

- 3f3b88f: **Breaking: rendering counts no longer scale with `--iterations`.** A count now describes the first
  timed iteration, so `assert --max-layouts 30` means the same thing at `--iterations` 1 and 50. Expect
  `layoutCount` and friends to drop by roughly your iteration count. `--no-isolate` and
  `--target firefox` cannot separate counts from wall and now say so in `meta.notes` instead of
  reporting totals silently.

  **Breaking: bench `wallMs` is now the sum of the timed iterations, not a trace-pass window.** `wallMs`
  excludes settle and is measured with tracing off, so it will differ from 0.5.x and `--max-wall`
  thresholds may need re-baselining. `perIteration` and `stats` are unchanged.

  Added: `--iterations` and `--warmup` now work in driver mode, not just `--bench`. Each iteration
  re-measures every step, so a step reports the median of its samples plus min/max in the new
  `StepIndexEntry.stats`, which `query index` prints. Step labels must be unique within an _iteration_
  rather than the whole run, and every iteration must measure the same steps or the run fails.

  Added: `meta.blameSemantic` records whether forced-layout blame names the `flush-site` (Chrome: the
  geometry read) or the `invalidation-site` (Firefox: the write that dirtied the DOM), which is why
  blame is not comparable across engines. `query blame` prints the semantic under the forced rows.

  Fixed: numeric options reject non-integers instead of swallowing them. `--iterations abc` became
  `NaN` and recorded a run reporting zero layouts; `--warmup 1.5` silently became `1`. Both now error,
  as does any non-integer passed to `--settle`, `--cpu-interval`, `--top` or `--max-*`.

- 7505d85: **Breaking: `--runtime` and `--browser` are replaced by one `--target chrome|firefox|node`.** Rename
  `--runtime node` to `--target node`, and `--browser firefox` to `--target firefox`.

  **Breaking: `--cpu-profile` is gone and CPU profiling is on by default on every target.** Drop the
  flag from your commands. `--no-cpu-profile` opts out on chrome only; firefox and node refuse the flag,
  because on those targets it would leave nothing to measure. Profiling costs no extra pass, but it
  adds ~10% to reported wall time, so pass `--no-cpu-profile` when you need absolute wall numbers.

  **Breaking: `--target node --bench` is now an error** instead of being silently ignored. `--bench`
  imports the module inside a page and the node target has no page; `--iterations` already repeats
  `run()` there.

  `--cpu-interval` now defaults to 200us instead of 50us on every target.

  Fixed: a firefox run without `--cpu-profile` used to report every rendering count as `0`,
  indistinguishable from a clean run; `--target firefox` now yields counts and blame with no extra flag.
  The "no sourcemap resolved" warning no longer fires for plain unbundled source, which needs no map,
  and new `SourceMapDiagnostics.unmappedBundles` / `CpuModel.unmappedFrames` report what a missing map
  actually costs you. With `--no-trace`, `meta.notes` no longer describes a trace pass that never ran.
  A trace-window warning told you to raise `--settle-ms`, which is not a flag; the flag is `--settle`.
  The `record` report now prints artifact paths relative to the current directory when that is shorter;
  the paths stored inside the artifacts stay absolute, so `latest` still reopens from any directory.

- fa2aca5: **Added:** a driver step now reports where its interaction's time went, split the way Core Web
  Vitals splits INP: `summary.interaction` and `StepIndexEntry.interaction` carry `inputDelayMs` (main
  thread busy at input), `processingMs` (your event handlers) and `presentationDelayMs` (rendering the
  result). These come from the in-page Event Timing observer, so they describe the page, and they are
  finer-grained than `inpMs`, which the spec rounds to 8ms: a 45ms handler reads `processingMs` 45.1.
  `query index` gains a `processing ms` column.

  **Changed:** `query index` leads with `inp ms` and `processing ms` and moves `wall ms` last, marked
  as a bound. A step's wall is measured around the driver, so it includes dispatching the action and
  waiting for the page to settle: identical work reports 40.5ms driven by `page.click` and 31.9ms by
  `page.evaluate`, of which the page did 1.1ms. Leading with it invited reading the driver's cost as
  the page's.

  **Fixed:** `query index <recording>` died with `Cannot read properties of undefined (reading
'length')`. It now says the file is a recording rather than a step index, and names the
  `.index.json` to pass instead.

## 0.4.0

### Minor Changes

- 336b2ce: **Breaking: stepped (driver) runs could report another step's numbers, or zeros.** The
  timing and trace passes were merged by numeric index, but each pass replays the flow in a fresh
  browser with its own counter. A flow that took a different path in the two passes could pair a step
  with the wrong trace window, or report `0` for every count — indistinguishable from a clean step, so
  `assert --max-forced 0` passed on steps that were never measured. Steps now merge by **label**, and a
  disagreement between the passes fails before any artifact is written.

  Two consequences: step labels must be unique within a run (disambiguate as e.g. `"mount@n=50"` /
  `"mount@n=400"`), and `measureStep` now throws if called from `cleanup()` — teardown runs after
  tracing stops, so those steps also reported `0` for every trace-derived count. Both fail on the
  offending call.

- b5f62a3: **Breaking: unmapped remote frames bucket by origin** (`(cdn.example.com)`) instead of
  `"app"`, which was blaming third-party scripts on your own bundle. `"app"` now means a resolved
  source outside `node_modules`. `cpu-diff --by package` across the 0.3 → 0.4 boundary shows a phantom
  `app` drop against the new `(host)` bucket; same-version diffs, `functionJoinKey` and `assert` are
  unaffected. A run whose own bundle ships no usable map now reads `(localhost:5173)`.

  Sourcemap failures are no longer silent — they were swallowed by a bare `catch`, leaving
  `query cpu --by package` reporting one bundle-shaped `app` bucket as if the feature did not exist.
  New optional `meta.sourcemaps` records how many scripts resolved and groups the failures by reason
  (`no-sourcemap-url`, `script-fetch-failed`, `map-fetch-failed`, `map-parse-failed`); the report
  prints `Sourcemaps: 0/1 resolved` and `meta.notes` warns when nothing resolved. `SourceMap` /
  `X-SourceMap` response headers are now honoured (production builds often strip the comment and keep
  the header), and one resolver is shared per run instead of re-fetching each script up to 3x.

- af91a28: Driver ergonomics:

  - Driver and `--runtime node` modules may live outside the working directory. They are imported in
    Node and never served, so the restriction only ever applied to `--bench`.
  - New `summary.perStep` gives each `measureStep` its labelled wall time, keeping raw samples and
    aggregating only against itself. Driver runs previously had no per-interaction wall at all:
    `summary.wallMs` is the whole run window (navigation + `prepare` + every step + settle).
  - Protocol timeouts now name `--protocol-timeout` rather than puppeteer's internal `protocolTimeout`
    option, and a missing browser prints an install line pinned to the exact build wpd requires.

### Patch Changes

- ee69f63: Firefox rendering counts now say where they came from. The report called them
  "authoritative" while the same run's `meta.notes` called them unmeasured; both were wrong.
  `layoutCount`, `styleCount` and `forcedLayoutCount` are real — counted from Gecko `Reflow`/`Styles`
  markers, with `--cpu-profile` — but Gecko batches layout differently than Blink, so they are not
  comparable to Chrome's CDP counts. `paintCount`, `compositeCount`, invalidations, long tasks and
  `scriptingMs` are reported as `0` because nothing measures them; the README's "never fake zeros"
  claim is corrected to match.

- 6e912a4: Correction: Firefox **does** measure INP — the 0.3.0 note saying otherwise was wrong. INP
  never came from CDP; it is an in-page Event Timing observer that Firefox 152 supports. No behavior
  changed, so if you skipped Firefox INP because of that note, it works. Caveat, measured rather than
  assumed: both engines span the interaction through the next paint, but presentation delay is
  engine-specific (128 ms firefox vs 160 ms chrome for one 100 ms handler), so Firefox reads
  systematically lower. Compare a browser against itself, not the two engines in one column.

## 0.3.0

### Minor Changes

- 80155d0: Add Firefox support via `--browser firefox`. Firefox is driven over WebDriver BiDi (no CDP) and
  measured with the Gecko profiler: wall/per-iteration timing, CPU self-time by package/file/function
  (`--cpu-profile`, `query cpu`), and forced layout/style blame to source lines (from Gecko
  Reflow/Styles markers, with `--cpu-profile`). Metrics with no Gecko equivalent (exact CDP counts,
  paint counts, invalidation rollup, INP, CPU/network throttling) are reported honestly in
  `meta.notes` rather than as fake zeros, and the CDP-only flags error out. Install the browser once
  with `npx puppeteer browsers install firefox`. Chrome remains the default with no behavior change
  (`meta.browser` is omitted for Chrome, so existing recordings stay valid).

## 0.2.0

### Minor Changes

- 2d90e93: cpu: bucket non-fetchable script URLs by scheme — `blob:`, inline `data:`/`javascript;` ESM modules, `wasm://`, and `v8/`/`extensions::` internals now group as `(blob)`/`(inline)`/`(wasm)`/`(native)`. Previously only `blob:` was handled; the rest fell through to filesystem package resolution and mis-attributed their CPU self-time to an unrelated package (often wpd's own). The base64 payload is also trimmed from the stored source.

  record: add `--no-trace` (counts-only via CDP + optional `--cpu-profile`, for pages whose trace pass is pathological), `--no-invalidation-tracking` (drop the heavy invalidationTracking category), and `--protocol-timeout <ms>`.
