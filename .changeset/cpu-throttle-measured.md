---
---

Docs-only: `docs/dev/cpu-profiling.md` now measures what `--cpu-throttle` does to each trust tier --
exact counts stay byte-identical, per-function attribution shares hold within noise (0.65pp max drift
at 4x), and the multiplier lands cleanly on CPU self-time (~4x), with a host-relative calibration
boundary. Adds a probe (`examples/throttle-mix.mjs`), a facts.md ledger row, README index entries, and
updates the `--cpu-throttle` surfaces register. No behavior change.
