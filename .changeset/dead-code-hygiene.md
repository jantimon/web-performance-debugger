---
"@jantimon/web-performance-debugger": patch
---

Remove dead internal exports: `longTasks`/`extractInvalidations` (`trace/analysis`), `isBrowserName`
(`browser/backend`), and the unused `colorEnabled`/`green`/`magenta` palette entries (`output/color`).
None are part of the public `index.ts` surface; no CLI output or behavior changes.
