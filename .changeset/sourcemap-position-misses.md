---
"@jantimon/web-performance-debugger": patch
---

Recordings now disclose per-script sourcemap position misses. A map that LOADS fine but has no
mapping for a queried line/col leaves that frame minified and origin-bucketed, invisible to the
existing load-failure diagnostics. `meta.sourcemaps.positionMisses` now records hits vs misses per
script, and a note names any script whose resolved map still dropped frames (honest counts, no
fabricated cost). Firefox recordings also carry a forced-count comparability note: `forcedLayoutCount`
comes from Gecko marker cause stacks (the write-site JS cause), not Chrome's read-site rule, so the
count is not comparable across engines.
