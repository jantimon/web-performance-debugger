# @jantimon/web-performance-debugger

## 0.2.0

### Minor Changes

- 2d90e93: cpu: bucket non-fetchable script URLs by scheme — `blob:`, inline `data:`/`javascript;` ESM modules, `wasm://`, and `v8/`/`extensions::` internals now group as `(blob)`/`(inline)`/`(wasm)`/`(native)`. Previously only `blob:` was handled; the rest fell through to filesystem package resolution and mis-attributed their CPU self-time to an unrelated package (often wpd's own). The base64 payload is also trimmed from the stored source.

  record: add `--no-trace` (counts-only via CDP + optional `--cpu-profile`, for pages whose trace pass is pathological), `--no-invalidation-tracking` (drop the heavy invalidationTracking category), and `--protocol-timeout <ms>`.
