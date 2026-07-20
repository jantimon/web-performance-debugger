---
"@jantimon/web-performance-debugger": patch
---

Document the measured wall-time overhead of each capture mode. The README's capture-mode table now
carries a Speed column rating each mode against a new no-measurement baseline row (`--precise-wall`
~0%, default ~4-7%, `--breakdown` ~25%, `--deep` ~70%, Firefox's gecko pass ~150%), with the numbers
from a re-runnable probe (`examples/capture-mode-speed.mjs`). Directional and machine-dependent.
