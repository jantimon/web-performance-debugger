# @jantimon/web-performance-debugger

## 0.13.1

### Patch Changes

- b7ff550: Fix four terminal-output defects surfaced dogfooding against a production site:

  - `query cpu` / `query span` / `cpu-diff` now compact an unmapped remote script URL (origin + truncated path, query string dropped) so a long third-party config URL no longer blows out the source column.
  - The per-span compositor frame side track collapses its dropped/janky frames to a one-line count; `query spans`/`query span --frames` lists each. JSON output keeps every per-frame record.
  - Drill-in hint lines print the recording as `latest` (or a cwd-relative path) instead of an absolute home/scratch path.
  - `query span <measure>` discloses that rendering counts do not window to a `performance.measure` span, so a bar with real style/layout/paint ms beside `—` counts no longer reads as a contradiction.

- dd008cd: Tighten the serving and launch surfaces. The `--bench` static server no longer sends a wildcard
  `Access-Control-Allow-Origin`: it grants CORS read access only to the one cross-origin host page a
  remote `--url` bench run needs, so no other site open in your browser can read cwd files off the
  loopback port while a run is live. It also rejects requests whose `Host` is not loopback, closing a
  DNS-rebinding read. `--disable-browser-sandbox` now refuses to combine with `--user-data-dir` (an
  unsandboxed renderer with your real profile has no safe use) and warns before launch when combined
  with a public `--url`.

## 0.13.0

### Minor Changes

- 9993cba: `--breakdown` now sources CPU samples from the trace's `v8.cpu_profiler` stream instead of the CDP
  sampler. The trace stream is continuous across a cross-document navigation, so a navigating driver
  step (or an early measure occurrence) now keeps its per-step CPU attribution -- the js-by-package
  split and hot-function list -- where the CDP sampler dropped it (it resets in the new renderer
  process). No CDP profiler runs on this rung.

  The sampler interval on `--breakdown` is now the stream's own fixed rate (~150us), read back from the
  chunks and recorded in `meta.cpuIntervalUs`/the CPU model, rather than the 200us default. Other rungs
  (default, `--deep`, `--precise-wall`, firefox, node) are unchanged. When a browser build emits no
  chunk stream, the run reports the counts and an honest note rather than fabricating samples.

- 408aa4c: **Per-step Long Animation Frame attribution (Chrome).** A driver step now carries the Long Animation
  Frames it triggered, naming the scripts that made a frame slow (the listener/callback, its script url,
  its duration, and the ms it forced in style/layout). The in-page observer is ungated, so a step gets
  script-level attribution even on the default rung (no trace, no CPU sampler window) and where the
  sampler could not reach. `query span <step>` prints the blamed scripts. Firefox has no LoAF API, so a
  Firefox step omits it rather than reporting a fake zero.

  **`waitForStable` completion helper for streamed / soft navigations.** A new exported `measureStep`
  `until` waits for a selector and then for the DOM to stop mutating, catching a streamed route
  transition the default settle can end before. Opt-in, since it trades a longer wall for catching the
  whole transition.

### Patch Changes

- cc6fe30: Firefox and frame-floor honesty in the breakdown/span output:

  - The "js is not pure JS" bar footer is now engine-conditioned. On Firefox a forced layout bills to
    the style/layout slices (js can read ~0), so the footer says that instead of repeating Chrome's
    "bills to the forcing frame".
  - Firefox bars disclose their ~1ms Gecko sampler granularity, so a 0 or 1 ms slice is not read as
    precise.
  - A Firefox forced-layout count carries a note that it is marker-derived and the read site is a
    sampled estimate that can miss cheap reads; an empty `query blame --forced` beside a nonzero count
    now says sampling missed the site, not "no forced layout".
  - `query span` surfaces the sample spread (min sample, js slice) beside a wall/INP median pinned to
    the frame floor, so a floored number is not read as "no difference".

- 39ffac7: **`query cpu --by package` no longer blames a dependency's cost on "app".** When a sourcemap remaps a
  frame to an original source that is not on the recorder's disk (a dependency built from a
  workspace/source checkout, or a stale map), the resolver used to fs-walk that phantom path up to the
  nearest `package.json` and land on the user's own root, so the dependency read as `app`. It now
  derives the owner from the path string: the `node_modules` package the phantom source or its bundle
  url names, else an honest `(unmapped: <dir>)` bucket, never `app`. Frames that were never remapped
  (the app's own source) are unaffected.

## 0.12.0

### Minor Changes

- c063a6c: `diff`/`cpu-diff` now compare the executed flow, not just the host page. A recording carries a
  structured workload identity (lane + host + module), so a `--fail-on-regression` gate refuses when a
  different module — or the built-in `--url` load flow — ran against the same host page, instead of
  subtracting two different programs and reporting a false pass.

  To gate, re-record both sides with the same module/flow. Recordings written before this field still
  diff against each other on the old target comparison; a new-vs-old pair warns that it cannot verify
  the flow.

- bf039c8: **`--warmup` now blocks a regression gate.** A `--warmup` difference between two recordings carries
  workload state (cache priming, JIT tiers, lazy CSS, memoization, first-render code): moving a call
  across the warmup boundary changes which counts and self-time land in the timed window, so a
  first-call layout can read as `0 -> 1` from config alone. `diff --fail-on-regression` and
  `cpu-diff --fail-on-regression` now REFUSE to gate across mismatched `--warmup` (they used to warn
  and gate anyway), naming the mismatch. Re-record both sides with the same `--warmup` to gate.

### Patch Changes

- 38b5c7c: Fix the `--breakdown` invalidation-count note, which told readers "a 0 there means unmeasured".
  Unmeasured counts render as `—`, never 0, so the note now says the counts are reported as not
  measured (—), never 0, matching every other not-measured note and the `Measured` model.
- 12f902c: `--deep` now captures far heavier journeys and never reports silently truncated counts. The trace runs
  on a raised 1 GB buffer (Chrome's default drops events past ~485k, a few steps into a production page),
  and wpd reads Chrome's `dataLossOccurred` verdict that Puppeteer discarded: on the rare trace that
  overflows even the raised buffer, `record` pushes a loud note (in the recording and on stderr) that
  counts are a floor, not exact. A trace past the ~512 MB a single string can hold now fails with a clear
  message naming the size and the remedy, instead of an unhandled `ERR_STRING_TOO_LONG`.
- 9c8edac: Keeps driver-mode `prepare()` and warmup out of the CPU model. The V8 sampler opened before
  `prepare()` ran, and the CPU model spans the whole profile, so page-side JS from setup inflated
  `scriptingMs`, the package rollup, the run-span hot functions and `cpu-diff` (measured: a `run()`
  doing ~5 ms beside a `prepare()` doing ~80 ms read `scriptingMs` ~88 ms with the setup loop as the top
  hot function). The sampler now opens at the `wpd:run:start` mark, pricing the run only (~9 ms on that
  probe), matching bench. Trace counts and `--breakdown` bars are unchanged; `cleanup()` was already
  excluded.
- 12f902c: New `record --keep-partial` (driver mode): when a later `--iterations` iteration fails on a flaky
  production site, keep the iterations that completed instead of discarding the whole run. The salvaged
  recording carries a loud note naming the failed iteration and the step it died on, and `meta.iterations`
  becomes the completed count. A failure in the FIRST iteration still errors: a flow that never completed
  once has nothing honest to salvage.
- 12f902c: `query spans` gains two filters for when a tag manager floods the overview with hundreds of tiny
  `performance.measure` spans: `--min-wall <ms>` hides spans below a wall threshold, and `--filter <text>`
  keeps only labels containing `<text>` (case-insensitive substring). Both combine with `--label` and with
  each other, and the output always states how many spans the filter hid, so a filtered view is never
  mistaken for the whole recording.
- 5f6a093: Fix the documented regression-gate example. It recorded one `--breakdown` run and then asserted
  `--max-forced` against it, but forced counts need the `--deep` `.stack` trace, so that budget always
  failed as a loud `n/a`. The README now records both rungs and gates each threshold on the rung that
  measured it: `--max-layouts`/`--max-slice` on `--breakdown`, `--max-forced` on `--deep`. An e2e test
  runs the two-capture workflow and checks both cross-rung mistakes still fail loudly.
- a25eb6d: Disclose that a chrome run's rendering counts (start-onward from `run:start`, so they catch the
  frame that paints just after `run:end`) and its `[run:start, run:end]` reconciling bar cover
  different windows, so a run `paintCount`/`layoutCount` above its bar slice reads as the trailing
  frame, not a bug. Shown as a `meta.notes` line under `--breakdown` and in `query span run`. No
  numbers changed.

## 0.11.1

### Patch Changes

- b124a5a: Makes per-driver-step CPU attribution honest across navigation. On a `--breakdown` journey the V8 CPU
  profiler resets on every cross-document navigation, so `Profiler.stop` returns only the samples since
  the run's LAST navigation: every step's iteration-0 window (and early `performance.measure`
  occurrences) ran before that point, so its bar showed real JS ms but an empty `js.byPackage` and a hot
  list suppressed as "0 pooled samples — raise --iterations". Raising iterations cannot recover a window
  the sampler never covered, so that hint was misleading.

  `query span` now distinguishes why a per-span hot tally is empty (new `suppressionReason` on the JSON
  `hot`): `below-floor` (a thin-but-real pool — raise --iterations), `no-js` (the window ran nothing to
  rank), or `not-covered` (the bar attributes real JS but the sampler recorded none — the navigation
  gap, where more iterations do not help). `record --breakdown` also emits a note when the sampler's
  first sample lands after the run window opened and a step/measure bar attributes JS it never covered.
  The trace-measured bar ms stay correct; only the sample-derived package/hot split of that JS is
  unavailable for pre-navigation windows. Steps the sampler DID cover (any non-navigating step)
  attribute in full, unchanged.

## 0.11.0

### Minor Changes

- 01b2c3d: `query span <label>` now shows per-span hot functions for step and measure spans, not just the run
  window. On a `--breakdown` chrome recording (step and measure spans) and a firefox recording (measure
  spans), the anatomy ranks the span's own hottest JS functions from the CPU sampler, resolved to
  source via the sibling CPU model.

  The list lives on the CPU-sampler scripting axis, so its `self %` is each function's share of the
  span's pooled JS samples (the panel discloses the pooled sample and occurrence counts); it is never
  reconciled against the bar's `js` slice. A measure pools samples across all its occurrences; a span
  with too few samples reports the ranking as suppressed with a raise-`--iterations` hint rather than a
  noisy top-N. The `hot.scope` / `hot.pooledSamples` / `hot.occurrences` / `hot.suppressed` fields are
  new in the `query span --json` output; `hot.sampleCount` is replaced by `hot.pooledSamples`, and
  stored per-span hot rows carry no `totalMs` (it was run-wide, not span-local).

### Patch Changes

- 08f4301: Fixes `--url` boot measurement across a cross-process navigation. A `--url` boot navigates wpd's
  blank host page to the target; when the target is a different site, Chrome swaps the renderer
  process, and `wpd:run:start` was left on the pre-navigation thread. `--breakdown`/`--deep` then
  reported the boot as ~100% idle with **zero** layout/style/paint counts, and `assert --max-layouts`
  passed at 0 on a page that clearly laid out. wpd now re-anchors counts and the reconciling bar to the
  renderer the page navigated into (disclosed in a note); single-process recordings and out-of-process
  iframes are unchanged. If you gated a real `--url` boot on these counts, the numbers were wrong and
  now reflect the loaded page.

  Also hardens the `--url` path: a transient cross-process navigation failure (`net::ERR_INVALID_HANDLE`
  and similar) is retried on a fresh browser up to twice instead of a hard exit; a positionless
  sourcemap frame no longer crashes the run with `` `line` must be greater than 0 ``; webpack's
  module-loader runtime (`webpack/bootstrap`, `webpack/runtime/*`) is bucketed as `(webpack)` instead of
  inflating your `app` self-time; and `--iterations` on the default `--url` rung now says plainly that a
  per-iteration wall/median needs `--breakdown`, rather than implying one exists.

- f82db2f: `cpu-diff --fail-on-regression` now refuses to gate across an `iterations` or `cpu-throttle`
  mismatch. CPU self-time totals across every sampled iteration and stretches under throttling, so
  those axes fabricated a self-time "regression" from pure config.

  `diff --fail-on-regression` help now promises what it actually gates: exit 1 on a gated exact-count
  increase; INP and other wall-tier numbers stay advisory (they were never gated).

  Sourcemap fetches that answer 401/403 now report a distinct `auth-required` diagnostic whose remedy
  names the auth wall instead of citing CORS (a browser-only concept that cannot apply to wpd's
  node-side, cookie-less fetch).

  The committed `package-lock.json` version now tracks `package.json`, with a unit test guarding
  against future drift.

- 6c8406b: `query spans` drill-down tips now echo the target you passed (e.g. `latest`) instead of the resolved
  absolute recording path, matching every other command and keeping your home directory out of pasted
  output, screenshots, and recorded terminals.

## 0.10.0

### Minor Changes

- f3ebcd9: Chrome now launches with its OS sandbox ENABLED by default; `--no-sandbox`/`--disable-setuid-sandbox`
  are no longer passed on every run. To launch anyway in an environment that cannot start the sandbox
  (containers, restricted CI), pass the new `--disable-browser-sandbox` flag, which restores both args
  with a loud WARNING in `meta.notes` and on stderr. If a sandboxed launch fails, wpd reports the
  sandbox error and names the flag rather than silently retrying unsandboxed. Firefox is unaffected.
- f3ebcd9: `diff` and `cpu-diff` now refuse to gate across captures that are not comparable, instead of emitting
  fabricated regressions. The `diff --fail-on-regression` comparability signature gains workload (the
  recorded module/page), headless flavour, and cpu-throttle as blocking axes, and iterations now blocks
  too (run counts total across iterations, so 1 vs 5 makes every count differ); warmup and sampler
  interval warn. `cpu-diff` gains a comparability check of its own: it warns on any capture-axis
  difference and refuses `--fail-on-regression` across a browser/runtime/workload mismatch. Two new
  `meta` fields (`headlessMode`, `cpuIntervalUs`) record the axes needed for the check.
- 6f69ea1: `record --url <url>` (or `--html <file>`) now works with **no module**: wpd runs a built-in driver
  flow that navigates to the target inside one `load` step and settles, so a first run needs zero
  authoring. The boot lands in the standard run window, so every rung works over it — default gives the
  four-slice CPU bar, `--breakdown` the reconciling bar plus counts, `--deep` forced-layout blame.

  INP stays null (a load has no interaction), and with `--iterations > 1` a note discloses that only
  iteration 1 is cold — later iterations reuse the one browser's caches. A module still works exactly as
  before; `--bench` and `--target node` still require one.

  `--url` is now the one documented way to name the host page and accepts a live URL **or** a local HTML
  file path — wpd tells them apart (a host-only value like `localhost:5173` gets `http://` assumed).
  `--html` still works as a hidden alias, so existing invocations are unchanged.

### Patch Changes

- 85cfcef: Firefox reconciling bars now split style vs layout more accurately, and Chrome `--deep` dirtied-by no
  longer stamps a self-referential `display:none` line.

  The Firefox six-slice bar was bucketing style-recalc wrapper/diff/stylist frames
  (`RestyleManager::...`, `ComputedStyle::CalcStyleDifference`, `Update stylesheet information`,
  `PresShell::DoFlushPendingNotifications Style`) as `layout`, under-counting `style` by ~10-25% on
  style-bound workloads. They now classify as `style`, so bars re-split: `style` rises and `layout`
  drops (to ~0 on pure-style workloads). Matching stays anchored, so the `CTFontFamily::FindStyleVariations`
  font frame and the ` Layout` flush sibling stay `layout`.

  Chrome `--deep` `query blame --forced` / `query span`: a `display:none` removal emits `"Removed from
layout"` at recalc time naming the geometry read, which surfaced as a self-referential "dirtied by
  <the read itself>" entry. That position-equal entry is now dropped; a genuine `removeChild` (a distinct
  write line) is kept. Thrash counts are unchanged.

- f3ebcd9: Bound the remote sourcemap fetcher for `--url` runs: a per-run 30s budget, per-response size caps
  (20MB scripts / 50MB maps, enforced by streaming so a missing content-length cannot overrun),
  bounded-concurrency fetching (4 at a time instead of strictly serial), and a network policy that
  follows redirects manually and refuses non-http(s) schemes and private/loopback hosts reached from a
  public page. Refused, oversized, and budget-exhausted lookups each record their own `meta.sourcemaps`
  diagnostic; localhost dev servers and served fixtures are unaffected.

## 0.9.0

### Minor Changes

- 39326d1: `--deep` (chrome) is the attribution report: exact forced-by read-sites plus the **dirtied-by** write
  that made each flush necessary, and a **layout-thrashing detector**.

  The thrash detector walks each top-level task in order and counts the write→read→write→read signature
  where a geometry read re-flushes a layout an intervening write just dirtied, matching invalidation
  kind to flush kind. `record --deep` prints `⚠ layout thrashed Nx` with the interleave; `query blame
--forced` shows the dirtied-by write under each read; `query span run` carries the thrash rollup.
  Slice durations stay suppressed on `--deep` (the `.stack` trace distorts them); run `--breakdown` for
  the reconciling bar.

- 39326d1: `diff` matches spans by `kind:label` and warns when a metric is comparable on one side only, rather
  than inventing a delta: a slice or count measured on one recording but not the other reports `n/a`,
  never a fabricated regression. The qualified `kind:label` join keeps a user `performance.measure`
  named `run` from colliding with the run span.
- 39326d1: `--deep --target firefox` surfaces Gecko's native cause-stack write identity as a first-class
  dirtied-by report. `query blame --dirtied` lists the write each forced flush blames, labelled
  `first-invalidation-only` (Gecko records only the first invalidation since the last flush, not
  Chrome's full write set), so it never fabricates a forced-by read side or count parity Chrome has and
  Firefox does not. The read side stays the sampled read-site blame (`query blame --forced`).
- 39326d1: New `query span <file> <label>` drills into one span's full anatomy: its reconciling bar, wall and
  aggregation with the sample spread, the Measured counts, INP and its CWV split, the forced read-sites
  with their dirtied-by writes and the thrash rollup (on an event-log rung), and the run-window hot
  functions. `<label>` is a bare label or a `kind:label` qualifier (`run:`, `step:`, `measure:`), so a
  label that collides across kinds is resolved rather than silently joined.
- 39326d1: **Breaking: one capture pass per `record`, selected by a rung flag.** The two-pass isolation and its
  negative-flag family are gone; every invocation is exactly one pass.

  - Rungs replace the flags: default is the four-slice CPU bar (no rendering counts); `--breakdown` is
    the reconciling seven-slice bar plus exact layout/style/paint counts; `--deep` is the attribution
    report (forced-by, dirtied-by, thrash, invalidation rollup, exact counts, no slice ms); `--precise-wall`
    is a sampler-off benchmark wall. Removed: `--no-isolate`, `--no-trace`, `--no-cpu-profile`,
    `--no-invalidation-tracking`, `--fn`, `--cpu-interval`, `--settle`, `--screenshot`, `--network`. Want
    the bar and the blame in one shot? Run `wpd` twice.
  - Counts are now trace-derived and windowed to the renderer main thread (the CDP `getMetrics` counters
    are gone). `layoutMs`/`styleMs`/`paintMs` are wall-tier (~1%, directional), measured only on the
    `--breakdown` light trace and reported `null` on `--deep`.
  - Driver step walls are re-priced on the page's own clock (the trace-clock window between a step's
    marks, or the page's `performance.now` delta), never the node-side `page.click` bound.
  - One artifact file per run (schema `3`): the recording carries the run summary and every span, with
    the classified event log inlined only under `--deep`/firefox. `query digest` and `query index` are
    removed — use `query spans` for the overview, then `query span <label>` for one span's anatomy.
    Recordings written by an older wpd are rejected on read: re-record.

## 0.8.0

### Minor Changes

- 77040ea: `assert` gains per-slice budgets and `diff` gains per-span slice deltas.

  `assert --max-slice <name>=<ms>` (repeatable, e.g. `--max-slice js=5 --max-slice layout=2`) gates a
  span's breakdown slice ms; `--label <label>` picks a span other than the run span. A budget on a
  slice or label the recording did not measure is a loud FAIL, never a silent pass. Slice ms is
  directional, never count-exact: trace wall-tier (~1%) on `--breakdown` bars, the profiler's own
  clock on CPU-only bars.

  `diff` now prints per-span slice ms deltas, matched by span label, for recordings that carry a
  breakdown. These are advisory (directional ms) and never fail the gate; count deltas still gate as before.
  Valid slices: js, style, layout, paint, gc, other, idle.

## 0.7.0

### Minor Changes

- dcafe12: `performance.measure` spans repeated under `--iterations` now merge their occurrences instead of
  reporting iteration 1's bar. The stored span is the lower-median-by-wall real occurrence, so
  `Σ slices + idle = wall` still holds exactly (no per-slice averaging). `query spans` / `query digest`
  disclose the merge: `aggregation: "median"`, `samples` (occurrence count), and `wallMinMs`/`wallMaxMs`
  (the wall spread). Chrome (`--breakdown`) and Firefox report identical semantics. Run/step spans and
  single-occurrence measures are unchanged; old recordings load as before.

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

- a0e674b: **Breaking: `paintCount` counts main-thread paint only, so expect it to drop sharply.** It no longer
  sums raster-worker events; it is now one per dirtied region. Re-baseline any `--max-paints` threshold.

  **Breaking: `compositeCount` and `compositeMs` are gone.** They tracked `--settle` duration rather than
  anything the page did. There is no replacement; read `paintCount`.

  **Breaking: a driver run reports no run-level `summary.wallMs` (it is `null`).** Per-step wall is
  unchanged in `summary.perStep` / `query index`; `assert --max-wall` against a driver recording now fails
  and points at the step index. `--bench` and `--target node` are unaffected.

- 4ccdbfc: **New: `--target firefox` gains the reconciling CPU-time breakdown bar.** The `record` report and
  `query cpu` show a `js · style · layout · browser · gc · idle` bar that tiles the sampled window exactly
  (style/layout from the sampled Layout-category frames). A Gecko dump without the CPU signal (older
  recordings) still gets no bar rather than a fabricated idle.

  **New: `performance.measure` spans on Firefox.** Each user measure inside the run window appears in
  `recording.breakdowns` (kind `measure`) with its own reconciling breakdown.

  **Changed: `query blame --forced` on Firefox now names the READ site + the DOM property** (e.g.
  `offsetWidth`), matching Chrome's flush-site semantics, so the two engines' forced lines are comparable
  at line granularity. `meta.blameSemantic` is `flush-site` on Firefox; the write/invalidation cause stays
  reachable via `query get`. Forced-layout counts still come from the Reflow/Styles markers.

- 4ccdbfc: **New: a reconciling CPU-time breakdown bar, `js · browser · gc · idle`.** It tiles the sampled
  window exactly (`js` split by package) and appears in the `record` report, in `query cpu` (human and
  `--json`/`--format`), and as an additive optional `breakdown` field on the `.cpu.json` model. Firefox
  reports its own six-slice bar (`js · style · layout · browser · gc · idle`); `--target node` measures
  pure JS. Old `.cpu.json` files without the field keep working.

- 4ccdbfc: **New: `--breakdown` records a per-span off-thread frame side track (Chrome).** Each span carries
  `frames` with the compositor's PipelineReporter verdicts: `presented` / `partial` / `dropped` /
  `no-update` counts, per-frame records, and the slowest presented (incl. partial) frame's top
  pipeline-stage durations. The `record` report and `query digest` print a compact line under each bar
  (`frames: N presented · N partial · N dropped`), and name any dropped or smoothness-affecting frame. It
  is DISPLAY-ONLY: `assert` and `diff` never gate on frame counts, `Paint` stays the only exact rendering
  count, and nothing here is summed into a breakdown bar. Additive: recordings without the field still load.

- 4ccdbfc: **Changed: the `latest` pointer no longer writes a `recordings/` dir into your cwd.** It is now
  cwd-keyed and stored under `$XDG_STATE_HOME/wpd/pointers/` (falling back to `~/.local/state/wpd/`).
  `latest` still resolves from the cwd you recorded in, and an in-flight `recordings/.wpd-last.json` left by
  an older run is still read as a fallback.

  **Docs: pnpm install recipe.** The README now documents the `onlyBuiltDependencies` /
  `ignoredBuiltDependencies` recipes (pnpm 10+ blocks Puppeteer's browser-download postinstall; pnpm 11
  hard-fails `pnpm exec wpd`).

  **Changed: `query cpu` states the iteration divisor** in its header when `--iterations > 1` (the JS
  self-time headline is a whole-window total; divide by N for a per-iteration figure).

- 4ccdbfc: **New: `query spans <file> [--label <L>]`: one unified per-span breakdown across every target.**
  Returns one entry per span (the run window, each driver step, and every user `performance.measure`) in a
  single slice shape (`js` with `byPackage`, `style`, `layout`, `paint`, `gc`, `other`, `idle`) whether the
  recording came from chrome `--breakdown`, `--target firefox`, or `--target node`. A slice a lane could
  not measure is an explicit `null`, never a fabricated `0`. `--label` filters to one span by exact label.
  New public types `SpansResult` / `SpanEntry` / `UnifiedSlices`. Each span declares `aggregation` (`"sum"`
  for the run window, `"first"` for a step or `performance.measure`) and `iterations`, so a consumer knows
  whether a span's numbers are a per-loop total or one iteration.

- 4ccdbfc: **New: `record --breakdown` (chrome), a reconciling seven-slice bar per span.** One fused pass (a
  light trace + the CPU sampler) produces `js (by package) · style · layout · paint · gc · other · idle`
  for the run window, each driver step, and every user `performance.measure` inside the run. Each bar tiles
  its window exactly (`Σ slices + idle = wall`). Stored additively as `Recording.breakdowns` and shown in
  the `record` report and `query digest`; old recordings keep loading. Forced-layout count and blame need
  the `.stack` category this mode drops, so they are reported as **not measured** (never 0) -- run the
  default mode for forced-layout blame.

  **New: `record --headless-mode new|shell` (chrome).** `shell` launches chrome-headless-shell, which runs
  frames at ~120Hz and halves the one-frame floor on `wall`/`INP` (16.6 -> 8.3ms). `shell` is the default;
  pass `--headless-mode new` to run the full-Chrome new headless (~60Hz) instead.

- 4ccdbfc: **Chrome now defaults to chrome-headless-shell (~120 Hz frames).** `wall`/`INP` read ~half of what
  they did on sub-frame work, so `assert --max-wall`/`--max-inp` thresholds tuned under the old default
  need re-tuning (or pass `--headless-mode new` to restore the old full-Chrome ~60 Hz cadence). Counts,
  forced-layout blame, and CPU self-time are unchanged. If chrome-headless-shell is not installed, the run
  falls back to new-headless with a warning instead of failing.

### Patch Changes

- de12174: **Fixed: `--protocol-timeout` now works on `--target firefox`.** The CLI previously rejected it as
  CDP-only; raise it when Firefox times out launching (`session.new timed out`).

  **Fixed: `--bench`'s help said `run()` takes "no args".** It gets `run(ctx)`, with live `document`/
  `window`, and pairs with `--html`/`--url` for a host page. The README now says which mode to pick.

## 0.5.0

### Minor Changes

- 3f3b88f: **Breaking: rendering counts no longer scale with `--iterations`.** A count now describes the first
  timed iteration, so `assert --max-layouts 30` means the same thing at `--iterations` 1 and 50. Expect
  `layoutCount` and friends to drop by roughly your iteration count. `--no-isolate` and `--target firefox`
  cannot separate counts from wall and now say so in `meta.notes` instead of reporting totals silently.

  **Breaking: bench `wallMs` is now the sum of the timed iterations, not a trace-pass window.** It excludes
  settle and is measured with tracing off, so it will differ from prior versions and `--max-wall`
  thresholds may need re-baselining. `perIteration` and `stats` are unchanged.

  Added: `--iterations` and `--warmup` now work in driver mode, not just `--bench`. Each iteration
  re-measures every step, so a step reports the median of its samples plus min/max in the new
  `StepIndexEntry.stats`, which `query index` prints. Step labels must be unique within an _iteration_
  rather than the whole run, and every iteration must measure the same steps or the run fails.

  Added: `meta.blameSemantic` records whether forced-layout blame names the `flush-site` (Chrome: the
  geometry read) or the `invalidation-site` (Firefox: the write that dirtied the DOM), which is why blame
  is not comparable across engines. `query blame` prints the semantic under the forced rows.

  Fixed: numeric options reject non-integers instead of swallowing them. `--iterations`, `--warmup`,
  `--settle`, `--cpu-interval`, `--top` and `--max-*` now error on a non-integer instead of coercing it.

- 7505d85: **Breaking: `--runtime` and `--browser` are replaced by one `--target chrome|firefox|node`.** Rename
  `--runtime node` to `--target node`, and `--browser firefox` to `--target firefox`.

  **Breaking: `--cpu-profile` is gone and CPU profiling is on by default on every target.** Drop the flag.
  `--no-cpu-profile` opts out on chrome only; firefox and node refuse the flag. Profiling costs no extra
  pass, but adds ~10% to reported wall time, so pass `--no-cpu-profile` when you need absolute wall numbers.

  **Breaking: `--target node --bench` is now an error** instead of being silently ignored. The node target
  has no page; `--iterations` already repeats `run()` there.

  `--cpu-interval` now defaults to 200us instead of 50us on every target.

  Fixed: `--target firefox` now yields counts and blame with no extra flag (a firefox run without
  `--cpu-profile` used to report every rendering count as `0`). The "no sourcemap resolved" warning no
  longer fires for plain unbundled source, and new `SourceMapDiagnostics.unmappedBundles` /
  `CpuModel.unmappedFrames` report what a missing map actually costs you. With `--no-trace`, `meta.notes`
  no longer describes a trace pass that never ran. A warning that told you to raise `--settle-ms` now names
  the real flag, `--settle`. The `record` report prints artifact paths relative to the current directory
  when that is shorter; stored paths stay absolute, so `latest` still reopens from any directory.

- fa2aca5: **Added:** a driver step now reports where its interaction's time went, split the way Core Web Vitals
  splits INP: `summary.interaction` and `StepIndexEntry.interaction` carry `inputDelayMs` (main thread busy
  at input), `processingMs` (your event handlers) and `presentationDelayMs` (rendering the result). These
  come from the in-page Event Timing observer and are finer-grained than `inpMs`, which the spec rounds to
  8ms. `query index` gains a `processing ms` column.

  **Changed:** `query index` leads with `inp ms` and `processing ms` and moves `wall ms` last, marked as a
  bound. A step's wall is measured around the driver, so it includes dispatching the action and waiting for
  the page to settle.

  **Fixed:** `query index <recording>` died with `Cannot read properties of undefined (reading 'length')`.
  It now says the file is a recording rather than a step index, and names the `.index.json` to pass instead.

## 0.4.0

### Minor Changes

- 336b2ce: **Breaking: stepped (driver) runs could report another step's numbers, or zeros.** The timing and
  trace passes were merged by numeric index, but each pass replays the flow in a fresh browser with its own
  counter, so a flow that took a different path could pair a step with the wrong trace window or report `0`
  for every count. Steps now merge by **label**, and a disagreement between the passes fails before any
  artifact is written.

  Two consequences: step labels must be unique within a run (disambiguate as e.g. `"mount@n=50"` /
  `"mount@n=400"`), and `measureStep` now throws if called from `cleanup()`, since teardown runs after
  tracing stops.

- b5f62a3: **Breaking: unmapped remote frames bucket by origin** (`(cdn.example.com)`) instead of `"app"`, which
  was blaming third-party scripts on your own bundle. `"app"` now means a resolved source outside
  `node_modules`. `cpu-diff --by package` across the 0.3 → 0.4 boundary shows a phantom `app` drop against
  the new `(host)` bucket; same-version diffs, `functionJoinKey` and `assert` are unaffected. A run whose
  own bundle ships no usable map now reads `(localhost:5173)`.

  Sourcemap failures are no longer silent. New optional `meta.sourcemaps` records how many scripts resolved
  and groups the failures by reason (`no-sourcemap-url`, `script-fetch-failed`, `map-fetch-failed`,
  `map-parse-failed`); the report prints `Sourcemaps: 0/1 resolved` and `meta.notes` warns when nothing
  resolved. `SourceMap` / `X-SourceMap` response headers are now honoured (production builds often strip the
  comment and keep the header), and one resolver is shared per run instead of re-fetching each script.

- af91a28: Driver ergonomics:

  - Driver and `--runtime node` modules may live outside the working directory; the restriction only ever
    applied to `--bench`.
  - New `summary.perStep` gives each `measureStep` its labelled wall time, keeping raw samples and
    aggregating only against itself. `summary.wallMs` is the whole run window (navigation + `prepare` +
    every step + settle).
  - Protocol timeouts now name `--protocol-timeout` rather than puppeteer's internal `protocolTimeout`
    option, and a missing browser prints an install line pinned to the exact build wpd requires.

### Patch Changes

- ee69f63: Firefox rendering counts now say where they came from. `layoutCount`, `styleCount` and
  `forcedLayoutCount` are real (counted from Gecko `Reflow`/`Styles` markers, with `--cpu-profile`) but
  Gecko batches layout differently than Blink, so they are not comparable to Chrome's CDP counts.
  `paintCount`, `compositeCount`, invalidations, long tasks and `scriptingMs` are reported as `0` because
  nothing measures them.

- 6e912a4: Correction: Firefox **does** measure INP — the 0.3.0 note saying otherwise was wrong. INP is an
  in-page Event Timing observer that Firefox 152 supports, so if you skipped Firefox INP because of that
  note, it works. Caveat, measured rather than assumed: both engines span the interaction through the next
  paint, but presentation delay is engine-specific (128 ms firefox vs 160 ms chrome for one 100 ms handler),
  so Firefox reads systematically lower. Compare a browser against itself, not the two engines in one column.

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
