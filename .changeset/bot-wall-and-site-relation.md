---
"@jantimon/web-performance-debugger": minor
---

**Breaking (`query blame --format json`):** each read-site row is now a structured location
(`{ source, line?, column?, ... }`) matching the human table's columns, instead of a single
`file:line:col` string under `at`. Split `at` yourself only if you still need the joined form.

Add bot-wall detection: when wpd's own navigation (the built-in `--url` load flow, a `--url` host page)
lands on a bot-challenge interstitial (Cloudflare, DataDome, hCaptcha, PerimeterX, Arkose), `record`
refuses before measuring — non-zero exit, an evidence-listed error, and a `<recording>.wall.png`
screenshot — rather than reporting the challenge page as the site. Detection is conservative (rendered
interstitial only, never a captcha script a form embeds). `--allow-bot-wall` measures it anyway, with a
loud note.

Add `siteRelation` (`same-origin` | `same-site` | `cross-site`) on `query cpu` origin buckets of a
`--url` run, via the public-suffix list. It is a URL-mechanical fact, never an ownership or
"third-party" claim (a cross-site CDN can be first-party-owned).

The built-in `--url` flow now names the failure class (navigation timeout, HTTP/2 reset,
context-destroyed) and points at the driver-module escape hatch: wpd retries its own machinery's races,
never the site's refusals.
