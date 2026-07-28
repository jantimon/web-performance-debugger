---
"@jantimon/web-performance-debugger": patch
---

Lower the cross-process split-detection floor so a lighter second navigation is not silently
uncounted. A run that navigates across renderer processes now sets `meta.mainThread.split` (so
`assert` / `diff --fail-on-regression` refuse count gates) once the second navigation renders at least
5% of the busiest thread's layout/paint -- the same husk share the re-anchor uses. A second navigation
doing 5-24% of the first page's work previously left `split` false, so `assert --max-layouts` gated
green on the first page's counts alone. Keep each run to one navigation for counts that cover all of it.
