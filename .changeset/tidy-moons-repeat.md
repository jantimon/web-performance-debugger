---
"@jantimon/web-performance-debugger": minor
---

**Added:** a driver step now reports where its interaction's time went, split the way Core Web
Vitals splits INP: `summary.interaction` and `StepIndexEntry.interaction` carry `inputDelayMs` (main
thread busy at input), `processingMs` (your event handlers) and `presentationDelayMs` (rendering the
result). These come from the in-page Event Timing observer, so they describe the page, and they are
finer-grained than `inpMs`, which the spec rounds to 8ms: a 45ms handler reads `processingMs` 45.1.
`query index` gains a `handler ms` column.

**Changed:** `query index` leads with `inp ms` and `handler ms` and moves `wall ms` last, marked as
a bound. A step's wall is measured around the driver, so it includes dispatching the action and
waiting for the page to settle: identical work reports 40.5ms driven by `page.click` and 31.9ms by
`page.evaluate`, of which the page did 1.1ms. Leading with it invited reading the driver's cost as
the page's.

**Fixed:** `query index <recording>` died with `Cannot read properties of undefined (reading
'length')`. It now says the file is a recording rather than a step index, and names the
`.index.json` to pass instead.
