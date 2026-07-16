# @jantimon/web-performance-debugger

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
