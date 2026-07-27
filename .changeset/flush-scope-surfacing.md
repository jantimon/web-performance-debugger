---
"@jantimon/web-performance-debugger": minor
---

Surface per-flush layout/style **scope** (how much of the page relaid out or recalculated).

- `query blame --forced` and the `query span` forced section (chrome `--deep`) now tag each
  read-site with the flush it caused: `N/M layout objects`, `K styled`, and the container root of a
  subtree-contained flush.
- `query span` and the `query spans`/`query span` JSON now carry a per-span scope **distribution**
  (`dirtyObjects`/`elementCount` p50 + max) on `--breakdown`.
- Layout scope is chrome-only; style scope is dual-engine (firefox reads the Gecko `Styles` markers'
  `elementsStyled`), compared within an engine. Aggregated as a distribution, never a sum, and shown
  beside the ms, never as a proxy for it.
