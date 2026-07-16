# @jantimon/web-performance-debugger

## 0.4.0

### Minor Changes

- af91a28: Driver-mode ergonomics: modules outside cwd, per-step wall, actionable errors

  - **Driver modules can now live anywhere.** `record` rejected any module outside the working
    directory ("so it can be served to the browser"), but only `--bench` imports the module inside the
    page. Driver and `--runtime node` modules are imported in Node over `file://` and were never
    served, so the restriction blocked a lane it never applied to. The check now runs only for
    `--bench`, where it is true.
  - **`summary.perStep`** reports each `measureStep`'s labelled wall timing on driver runs. Previously
    a driver run had no per-interaction wall in `summary` at all: `summary.wallMs` is the whole
    `wpd:run` window (navigation + `prepare` + every step + settle), and the top-level
    `perIteration`/`stats` are bench-only, because a median across heterogeneous steps is meaningless.

    ```json
    "perStep": [{ "label": "open menu", "perIteration": [31.2], "stats": null }]
    ```

    Each step keeps its **raw samples** and aggregates only against itself (`stats` is `null` below 2
    samples, the same contract as the bench stats). A driver flow runs once per pass today, so each
    step holds one sample; the array is the axis that grows if steps become repeatable, so the shape
    will not have to change. The report prints the steps as a labelled table and now names the wall
    row "wall (whole run window)".

  - **Protocol timeouts name the flag that fixes them.** Puppeteer's message points at the
    `protocolTimeout` option of "launch/connect calls", an API a CLI user never touches; `record` now
    appends the `--protocol-timeout` hint.
  - **A missing browser prints a copy-pasteable install line** pinned to the exact build wpd requires
    (`npx puppeteer browsers install firefox@stable_152.0.2`). The generic
    `npx puppeteer browsers install firefox` installs whatever the ambient puppeteer pins, which can
    differ and leave the same error in place. The build is scraped from puppeteer's own error, so it
    cannot drift from the real requirement.

- b5f62a3: Report sourcemap resolution instead of failing silently; stop blaming unmapped code on `app`

  Per-package CPU attribution depends on a bundle's sourcemap. Every failure to fetch one was
  swallowed by a bare `catch`, so `query cpu --by package` reported a single bundle-shaped `app`
  bucket of minified frame names with no indication anything had gone wrong. It reads as "wpd cannot
  attribute a minified bundle" when the real cause is a map wpd could not reach.

  - **`meta.sourcemaps`** (new, optional) records every script a map was attempted for, how many
    resolved, and the failing urls grouped by reason: `no-sourcemap-url`, `script-fetch-failed`,
    `map-fetch-failed`, `map-parse-failed`. The record report prints a `Sourcemaps: 0/1 resolved` line
    under the package table, and `meta.notes` carries a `WARNING` when nothing resolved.
  - **`SourceMap` / `X-SourceMap` response headers** are now honoured, not just the trailing
    `sourceMappingURL` comment. Production builds commonly strip the comment and keep the header, in
    which case attribution previously failed with no explanation.
  - **BREAKING — unmapped remote frames bucket by origin**, e.g. `(cdn.example.com)`, instead of
    `"app"`. Third-party scripts without maps (analytics, chat widgets) were being blamed on your own
    bundle. `"app"` now means what it says: a resolved source outside `node_modules`.

    This changes `package` values, so **`cpu-diff --by package` across recordings made before and
    after this release** will show a phantom `app` drop against a new `(host)` bucket. Diffs between
    two recordings from the same version are unaffected, as are `functionJoinKey` (joins on `file`)
    and `assert` (never reads `package`).

    Note a run whose own bundle ships no usable map now reports its code under `(localhost:5173)`
    rather than `app`. That is the honest answer — the owner is genuinely unknown — and
    `meta.sourcemaps` says why.

  - **One `SourceMapResolver` per run**, shared by both stack-resolution passes and the CPU model
    build. Each previously built its own, re-fetching the same remote script and map up to 3x per run.

- 336b2ce: Fix stepped (driver) runs silently reporting another step's numbers, or zeros

  A stepped run records the flow twice (a clean timing pass and an instrumented trace pass) and
  merges the two. That merge paired steps by their numeric index — but each pass replays the flow in
  a fresh browser with its own counter, so index N in one pass and index N in the other are the same
  step only by coincidence, and nothing verified it (the `wpd:step:N` markers carry no label).

  When a flow took a different path in the two passes, index N could mean a different step in each:
  one step inherited another step's trace window and reported its layout/paint/forced-layout counts,
  while a step with no match reported **zero** for all of them. Zeros are indistinguishable from a
  genuinely clean step, so `wpd assert --max-forced 0` passed on steps that were never measured.

  Steps are now matched by label, and a disagreement between the passes is an error naming the
  steps involved instead of a plausible-looking recording. The check runs before any artifact is
  written, so a rejected run cannot leave a recording behind or move the `latest` pointer.

  A lane that collects no trace windows at all (e.g. Firefox without `--cpu-profile`) is treated as
  absence rather than disagreement and still records. Note that such a run reports `0` for every
  trace-derived count, which `assert` cannot distinguish from a genuinely clean run — that gap is
  unchanged here and is tracked separately.

  **Breaking:** step labels must now be unique within a run. Repeated labels previously "worked"
  (the index kept them apart) but produced a step index with two indistinguishable rows, and the
  label cannot identify a step across passes if it is not unique. `record` now fails on the
  offending `measureStep` call with a message naming the duplicate; disambiguate the labels
  (e.g. `"mount@n=50"` / `"mount@n=400"`).

  **Breaking:** `measureStep` now throws if called from `cleanup()`. Teardown runs after tracing
  stops, so such a step was never traced and reported `0` for every trace-derived count as though
  it were clean. Measure it in `run()` instead.

### Patch Changes

- ee69f63: Stop Firefox runs claiming their rendering counts are authoritative, and stop claiming they are absent

  A single Firefox run made two contradictory claims about the same numbers, and both were wrong.
  The report printed `Rendering work (counts are authoritative; durations are coarse)` — an
  unconditional header — above a table reading `layout 7, style recalc 15`, while that run's own
  `meta.notes` said `exact layout/style/script counts ... are NOT measured`.

  The counts do exist. Firefox has no CDP, so the summary falls back to counting the Gecko
  profiler's `Reflow`/`Styles` markers: `layoutCount`, `styleCount` and `forcedLayoutCount` are real
  and useful. But they are not authoritative — Gecko batches layout differently than Blink, so they
  count a different thing than Chrome's CDP counters. Telling users they were authoritative invited
  diffing them straight against a Chrome run and drawing a nonsense conclusion; telling users they
  were unmeasured hid a working signal.

  Now the header names its lane: CDP counters are authoritative, Gecko-marker counts say so and say
  they are not comparable to Chrome, and a Firefox run without `--cpu-profile` (which has no
  counting mechanism at all, so every count is `0`) says that instead of implying the page was
  clean. The Firefox note names exactly which fields are measured, which are a hard `0`, and what
  the measured ones may be compared against.

  The README's "never fake zeros" claim is corrected in the same spirit: `paintCount`,
  `compositeCount`, the invalidation counts, long tasks and `scriptingMs` are all reported as `0` on
  Firefox because nothing measures them. That gap is unchanged here — reporting "not measured"
  distinctly from `0` needs per-field availability metadata — but it is now documented rather than
  denied.

- 6e912a4: Correction: Firefox **does** measure INP; the note saying otherwise was wrong

  0.3.0 told users that on `--browser firefox` "INP is NOT measured", listing it alongside the
  genuinely CDP-dependent metrics. That was false. INP has never come from CDP: it is an in-page Event
  Timing `PerformanceObserver` installed by the driver, ungated by browser capabilities, and Firefox
  152 supports it (`event` and `first-input` are in `supportedEntryTypes`). Firefox driver runs have
  been reporting real per-step INP all along, while wpd's own output denied it.

  No behavior changed — only the claim. If you skipped Firefox INP because of that note, it works.

  **The honest caveat, measured rather than assumed** (Firefox 152 / Chrome 150, one 100 ms click
  handler on an identical page): chrome reports `duration` 160 ms (processing 112.2 + presentation
  47.4), firefox 128 ms (processing 111.0 + presentation 16.0). Both span the interaction **through
  the next paint** and round to 8 ms, so Firefox is not a truncated processing-only number. But
  presentation delay is genuinely engine-specific, so Firefox reads systematically lower for identical
  work. Compare a browser against itself across a change; do not put the two engines in one column.

  `meta.notes` now says this, the README support matrix marks INP `✓` for firefox, and long tasks are
  correctly attributed to the absent DevTools trace (not to an absent `longtask` observer — wpd never
  used one).

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
