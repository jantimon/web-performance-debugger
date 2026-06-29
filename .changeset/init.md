---
"@jantimon/web-performance-debugger": minor
---

Initial release. Drive Chrome via Puppeteer to attribute layout/paint/style/invalidation work to
source lines: forced-reflow detection (layout thrashing) with source attribution, two-pass
measurement isolation, a context-friendly digest, and `assert` / `diff` for CI gating.

`record` drives a real page by default (`run({ page, ctx, measureStep })`, per-step recordings with
INP); `--bench` imports the module in-page and calls `run()` (`--iterations` / `--warmup`);
`--cpu-profile` adds a V8 sampling pass attributing JS self-time to source/package; `--runtime node`
profiles pure-JS modules in-process with no browser (CPU only).

Stable, semver-covered TypeScript types for every JSON artifact and `--format json|toon` output via
a root entrypoint (`import type { CpuModel, Recording, Digest, CpuOverview } from
"@jantimon/web-performance-debugger"`); each artifact stamps `meta.schemaVersion` so files are
self-describing. Gating is honest by tier: `diff --fail-on-regression` gates only on exact CDP
counts (`wall`/`INP`/`scripting` are printed as advisory, since they ride a Chrome-clamped clock);
use `cpu-diff` for a JS-cost gate with a sampling-noise floor.
