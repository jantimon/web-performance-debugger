---
"@jantimon/web-performance-debugger": patch
---

Driver reliability fixes:

- **INP no longer under-reports on a slow environment.** The end-of-step flush now drains every in-page observer's `takeRecords()` (INP, LoAF, layout-shift, LCP, soft-nav) before reading, and waits (bounded) for the Event Timing entry on a step that dispatched a trusted interaction. An entry queued-but-undispatched at the read instant was silently lost, reading INP lower and letting a real regression slip past `assert --max-inp`.
- **A mid-step hard navigation no longer hard-fails the record.** When a step's action triggers a navigation that commits during the default settle, the settle re-attaches to the new document instead of dying with "Execution context was destroyed".
- **SIGINT/SIGTERM/SIGHUP now clean up.** A killed run SIGKILLs its Chrome process and unlinks its temp files instead of orphaning them, then re-raises the signal.
