---
"@jantimon/web-performance-debugger": patch
---

Add `WPD_INP_ENTRY_WAIT_MS` to raise the bounded in-page drain that a step waits for a trusted
interaction's Event Timing entry. The default stays 250ms; a genuinely slow host, where the entry's
task slips later, can extend it (whole ms) so per-step INP still lands. No change to default behaviour
or output.
