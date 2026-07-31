---
"@jantimon/web-performance-debugger": patch
---

Bot-wall detection no longer forces a layout flush while it inspects a page. The collector reads
iframe viewport coverage through an `IntersectionObserver` and the near-empty-DOM signal through
`textContent`, instead of `getBoundingClientRect`/`innerText`, and the on-ramp inspection runs outside
the `wpd:run` window. On a page that keeps layout dirty this drops a few spurious layout/style counts
that the inspection previously added to the run span. Detection results are unchanged.
