---
"@jantimon/web-performance-debugger": minor
---

`diff`/`cpu-diff` now compare the executed flow, not just the host page. A recording carries a
structured workload identity (lane + host + module), so a `--fail-on-regression` gate refuses when a
different module — or the built-in `--url` load flow — ran against the same host page, instead of
subtracting two different programs and reporting a false pass.

To gate, re-record both sides with the same module/flow. Recordings written before this field still
diff against each other on the old target comparison; a new-vs-old pair warns that it cannot verify
the flow.
