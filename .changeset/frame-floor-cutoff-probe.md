---
---

Docs only, plus an internal dedup: record the probe behind the frame-floor wait-share cutoff (0.8) in
`docs/dev/frame-floor.md` and the ledger, and fold the two duplicate `0.8` constants
(`FRAME_FLOOR_WAIT_SHARE`, `IDLE_DOMINANT_SHARE`) into one shared `IDLE_DOMINANT_SHARE`. No package
change: same value, same behavior.
