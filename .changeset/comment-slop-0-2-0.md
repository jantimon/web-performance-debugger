---
"@jantimon/web-performance-debugger": patch
---

Update `eslint-plugin-no-comment-slop` to 0.2.0, adding its two new rules at error: member comments
use JSDoc (not `//`), and every member of a mostly-documented type carries a one-line doc. All
findings fixed; internal only, no runtime or output change.
