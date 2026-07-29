---
"@jantimon/web-performance-debugger": minor
---

Dogfood remediation and a CI-gap close:

- **Cloudflare inline managed challenge** is now detected: its same-origin `/cdn-cgi/challenge-platform/` script, the `window._cf_chl_opt` page global, and a `__cf_chl_rt_tk` document token are strong signals, so a "Just a moment" interstitial no longer measures as the site. An embedded cross-origin Turnstile widget still passes.
- **`meta.browserVersion`** stamps the resolved engine build (chrome/firefox `browser.version()`, node `process.version`) as `{ raw, milestone }`, and a new **`browser-version` comparability axis WARNS** (never blocks) when two recordings' milestones differ: exact counts survive a bump, directional numbers do not.
- **`meta.botWall`** carries the detection verdict as structured data when `--allow-bot-wall` measured a challenge page anyway.
- `query span --format json` gains **`softNavAgreement`** (the classifier-vs-engine soft-nav reconciliation, previously human-report-only); `engineSoftNav` is already emitted.
- **Site relation** now tags a `--url` run's resolved remote packages/files (not just unmapped origin buckets), from the script origin they resolved from; a mixed-origin bucket stays untagged.
- wpd's own bot-wall probe frame no longer buckets in `query cpu`.
- New README "Running wpd in CI" section (cache the pinned browser; when a preinstalled browser is safe). Puppeteer is pinned exactly.
