---
"@jantimon/web-performance-debugger": patch
---

Enforce two comment/naming lint rules repo-wide via oxlint JS plugins: `id-length`
(single-letter identifiers banned beyond the integer counters `i`/`j`/`n`) and the vendored
`no-comment-slop` plugin (no trailing period, em-dash, banner, foreign syntax, or jargon; JSDoc
for exported symbols). All findings fixed; internal only, no runtime or output change.
