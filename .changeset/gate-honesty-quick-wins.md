---
"@jantimon/web-performance-debugger": patch
---

`cpu-diff --fail-on-regression` now refuses to gate across an `iterations` or `cpu-throttle`
mismatch. CPU self-time totals across every sampled iteration and stretches under throttling, so
those axes fabricated a self-time "regression" from pure config.

`diff --fail-on-regression` help now promises what it actually gates: exit 1 on a gated exact-count
increase; INP and other wall-tier numbers stay advisory (they were never gated).

Sourcemap fetches that answer 401/403 now report a distinct `auth-required` diagnostic whose remedy
names the auth wall instead of citing CORS (a browser-only concept that cannot apply to wpd's
node-side, cookie-less fetch).

The committed `package-lock.json` version now tracks `package.json`, with a unit test guarding
against future drift.
