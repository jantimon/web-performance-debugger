---
"@jantimon/web-performance-debugger": patch
---

A `--breakdown` driver step now headlines its MEDIAN per-iteration wall everywhere, not the bar's
iteration-0 window (which an outlier iteration 0 could inflate ~70x).

- `query spans`/`query span` (human and `--format json`/`toon`) report the median as a step's
  `wallMs`; the `median of N samples` tag now describes that number truthfully.
- The step's reconciling bar keeps tiling iteration 0 and is labeled `iteration-0 window <ms>`;
  its window rides the new `breakdownWallMs` field, which the slices reconcile to.
- Structured-output consumers see the corrected `wallMs` value for step spans.

Run/measure spans, the stored artifact, and `assert`/`diff` are unchanged.
