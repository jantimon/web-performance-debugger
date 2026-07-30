---
"@jantimon/web-performance-debugger": minor
---

Bot-wall detection now runs on a `page.goto` a driver module performs, not only on wpd's own
built-in load flow. A hand-authored flow that navigates onto a Cloudflare/DataDome interstitial is
refused with the same evidence, screenshot, and non-zero exit as the built-in flow, instead of
measuring the challenge page as the site. `--allow-bot-wall` measures it anyway with the loud note.
