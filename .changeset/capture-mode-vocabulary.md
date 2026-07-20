---
"@jantimon/web-performance-debugger": patch
---

Rename the "rung" vocabulary to "capture mode" across the README, CLI help, error messages, notes,
and reports. The chrome capture modes are default, `--breakdown`, `--deep`, and `--precise-wall`.

No behavior or artifact-format change: `meta.passes` values and `meta.schemaVersion` are unchanged,
so existing recordings still read. Note prose changed wording only.
