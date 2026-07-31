---
"@jantimon/web-performance-debugger": patch
---

Update the vendored `no-comment-slop` lint plugin to the latest upstream: JSDoc that documents an
export now gets its own line budget, `@example`/fenced-code lines and `SPDX` headers stop counting,
and the export-doc association reaches across blank lines. Internal only, no runtime or output change.
