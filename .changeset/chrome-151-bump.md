---
"@jantimon/web-performance-debugger": patch
---

Move the bundled browser to Chrome 151 (Puppeteer 25.4.0), so CI, e2e, and a fresh install all run
one browser. Re-probed the load-bearing headless facts on 151: the one-frame floor (16.7 ms / 60 Hz)
is unchanged; the GPU frame-sink stall no longer reproduces (its `--in-process-gpu` forcing lever now
produces frames cleanly), so the `--disable-gpu` default stays as belt-and-braces; boot-LCP delivery
still recovers within its bounded budget, with no missing-entry or 60 s-`startTime` anomaly; and a
cross-origin LCP without `Timing-Allow-Origin` now reports a coarsened `renderTime` (more data, not
wrong data). Soft-navigation entry types (`soft-navigation`, `interaction-contentful-paint`) are
present by default in the measured browser.
