---
"@jantimon/web-performance-debugger": patch
---

Fix the documented regression-gate example. It recorded one `--breakdown` run and then asserted
`--max-forced` against it, but forced counts need the `--deep` `.stack` trace, so that budget always
failed as a loud `n/a`. The README now records both rungs and gates each threshold on the rung that
measured it: `--max-layouts`/`--max-slice` on `--breakdown`, `--max-forced` on `--deep`. An e2e test
runs the two-capture workflow and checks both cross-rung mistakes still fail loudly.
