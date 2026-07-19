---
"@jantimon/web-performance-debugger": minor
---

`record --url <url>` (or `--html <file>`) now works with **no module**: wpd runs a built-in driver
flow that navigates to the target inside one `load` step and settles, so a first run needs zero
authoring. The boot lands in the standard run window, so every rung works over it — default gives the
four-slice CPU bar, `--breakdown` the reconciling bar plus counts, `--deep` forced-layout blame.

INP stays null (a load has no interaction), and with `--iterations > 1` a note discloses that only
iteration 1 is cold — later iterations reuse the one browser's caches. A module still works exactly as
before; `--bench` and `--target node` still require one.
