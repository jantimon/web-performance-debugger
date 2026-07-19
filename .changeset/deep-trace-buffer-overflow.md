---
"@jantimon/web-performance-debugger": patch
---

`--deep` now captures far heavier journeys and never reports silently truncated counts. The trace runs
on a raised 1 GB buffer (Chrome's default drops events past ~485k, a few steps into a production page),
and wpd reads Chrome's `dataLossOccurred` verdict that Puppeteer discarded: on the rare trace that
overflows even the raised buffer, `record` pushes a loud note (in the recording and on stderr) that
counts are a floor, not exact. A trace past the ~512 MB a single string can hold now fails with a clear
message naming the size and the remedy, instead of an unhandled `ERR_STRING_TOO_LONG`.
