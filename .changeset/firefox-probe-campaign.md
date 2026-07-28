---
---

Docs only: record the Firefox probe campaign findings. Firefox CPU self-time is contaminated by the
`js`-feature per-reflow stack capture (real main-thread CPU billed to the forcing frame), so
cross-engine self-time crosses cleanly only on pure JS (FF 0.83x chrome) and runs 1.5-3x on
reflow-heavy work; the marker-under-reported `forcedLayoutMs` is recoverable in magnitude from the
sample layout slice; boot-LCP identity is cross-engine parity for raster/text heroes but not SVG;
`processingMs` still crosses on a yielding handler; and the stamped 8.3 ms Firefox frame floor is
display-contingent (reads 16.6 ms / 60 Hz headless on an idle-panel host). No package change.
