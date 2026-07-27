---
"@jantimon/web-performance-debugger": minor
---

**Breaking:** Chrome's built-in headless (full Chrome, windowless) is now the only headless mode.
chrome-headless-shell is removed, and `--headless-mode` is removed (an explicit flag now errors with
a clear message). wpd measures how real Chrome performs, so it runs real Chrome, not a scraping/PDF
build.

Consequences:
- The `wall`/`INP` one-frame floor is now ~16.6 ms (Chromium's synthetic 60 Hz default) and
  deterministic across machines and CI, instead of shell's environment-contingent ~8.3 ms.
- Launch costs ~380 ms more per invocation than shell.
- A recording taken under the old shell mode gate-refuses a `diff`/`cpu-diff` against a new one (the
  frame-cadence axis differs), rather than comparing two different floors as one.
- chrome-headless-shell is no longer used; skip its Puppeteer download with
  `PUPPETEER_SKIP_CHROME_HEADLESS_SHELL_DOWNLOAD=true` (see README).
