---
"@jantimon/web-performance-debugger": minor
---

**Breaking:** `record --html <file>` is removed. Use `--url <file-or-url>`: it already accepts a
local HTML file or a live URL. An explicit `--html` now fails with a message naming the replacement.

`--json` is no longer documented on the `query`/`cpu-diff` verbs; the documented spelling is
`--format json`. The old `--json` flag keeps working as a hidden alias, so existing scripts are
unaffected.
