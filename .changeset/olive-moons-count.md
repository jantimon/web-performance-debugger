---
"@jantimon/web-performance-debugger": minor
---

**Breaking: `paintCount` counts main-thread paint only, so expect it to drop sharply.** It also
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
