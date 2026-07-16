# @jantimon/web-performance-debugger

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
