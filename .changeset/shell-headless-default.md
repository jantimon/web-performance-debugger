---
"@jantimon/web-performance-debugger": minor
---

**Chrome now defaults to chrome-headless-shell (~120 Hz frames).** `wall`/`INP` read ~half of what
they did on sub-frame work, so `assert --max-wall`/`--max-inp` thresholds tuned under the old default
need re-tuning (or pass `--headless-mode new` to restore the old full-Chrome ~60 Hz cadence). Counts,
forced-layout blame, and CPU self-time are unchanged. If chrome-headless-shell is not installed, the
run falls back to new-headless with a warning instead of failing.
