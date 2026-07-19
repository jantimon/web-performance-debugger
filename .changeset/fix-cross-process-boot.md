---
"@jantimon/web-performance-debugger": patch
---

Fixes `--url` boot measurement across a cross-process navigation. A `--url` boot navigates wpd's
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
