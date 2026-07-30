---
"@jantimon/web-performance-debugger": patch
---

Three reporting fixes for the built-in `--url` load flow:

- The record report's per-step wall table prints `—` for a step whose wall the capture mode
  never priced (default mode), instead of a literal `0` that read as "instant".
- `query span <navigation-step>` now explains an absent CLS (no qualifying shift on Chrome, or
  no layout-shift entry type on Firefox) rather than showing nothing.
- A commit-only step-span React block points at the run span, where the detected
  version/build/renderer live.
