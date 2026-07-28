---
"@jantimon/web-performance-debugger": minor
---

Firefox honesty pass, plus a frame-floor fix:

- Firefox frame floor corrected to the measured **16.6 ms** (was 8.3 ms): the 8.3 ms / 120 Hz reading
  is display-contingent, so on CI and idle-panel hosts Firefox sits on the same ~60 Hz floor as Chrome.
- Firefox `forcedLayoutMs` is now honestly **not-measured** (—), never the misleading number: the
  markers under-report the forced subset ~7x. Forced COUNTS are unchanged; read the bar's `layout`
  slice for total layout ms.
- Cross-engine CPU self-time copy scoped to pure-JS / `--target node` work (reflow-heavy Firefox
  self-time carries a per-reflow marker tax, 1.5-3x).
- `query span` now annotates a wall/INP sitting on **n× the frame floor** (n up to 4) when the window
  is wait-dominated, and exposes the match as a `frameFloor {floorMs, multiple}` field on the
  `--format json` view so consumers can detect flooring programmatically.
- `record` failures now lead with the cause on every path, with the `WPD_DEBUG` hint trailing on the
  same line, so the last stderr line always names the actual error.
