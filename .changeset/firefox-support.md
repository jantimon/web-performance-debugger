---
"@jantimon/web-performance-debugger": minor
---

Add Firefox support via `--browser firefox`. Firefox is driven over WebDriver BiDi (no CDP) and
measured with the Gecko profiler: wall/per-iteration timing, CPU self-time by package/file/function
(`--cpu-profile`, `query cpu`), and forced layout/style blame to source lines (from Gecko
Reflow/Styles markers, with `--cpu-profile`). Metrics with no Gecko equivalent (exact CDP counts,
paint counts, invalidation rollup, INP, CPU/network throttling) are reported honestly in
`meta.notes` rather than as fake zeros, and the CDP-only flags error out. Install the browser once
with `npx puppeteer browsers install firefox`. Chrome remains the default with no behavior change
(`meta.browser` is omitted for Chrome, so existing recordings stay valid).
