---
"@jantimon/web-performance-debugger": patch
---

Firefox dogfood fixes plus a cross-engine `query spans` and CPU-attribution fix:

- `query spans` now lists driver steps that carry no bar of their own (default/`--precise-wall`
  captures, and navigating steps) alongside the run bar, in JSON (`barlessSpans`) and human output,
  instead of returning the run span alone.
- Automation dispatch no longer ranks as app JS: Firefox's WebDriver code (`chrome://remote/`,
  `synthesizeMouseAtPoint`) and Puppeteer's own `page.click` machinery (`node_modules/puppeteer-core/`,
  which also leaked a `%2Fpuppeteer-core...` bucket into `byPackage`) are dropped to the browser slice.
- The Firefox wall note now states the profiler's real cost (~150% on reflow-heavy work, ~5% on pure
  JS), and the forced-layout note discloses that its milliseconds under-report ~7x vs Chrome.
- `examples/measure-span.mjs` does enough work that its Firefox bar and hot functions are populated at
  the iterations its own docstring recommends.
