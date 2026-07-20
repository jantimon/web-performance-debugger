---
"@jantimon/web-performance-debugger": patch
---

Firefox and frame-floor honesty in the breakdown/span output:

- The "js is not pure JS" bar footer is now engine-conditioned. On Firefox a forced layout bills to
  the style/layout slices (js can read ~0), so the footer says that instead of repeating Chrome's
  "bills to the forcing frame".
- Firefox bars disclose their ~1ms Gecko sampler granularity, so a 0 or 1 ms slice is not read as
  precise.
- A Firefox forced-layout count carries a note that it is marker-derived and the read site is a
  sampled estimate that can miss cheap reads; an empty `query blame --forced` beside a nonzero count
  now says sampling missed the site, not "no forced layout".
- `query span` surfaces the sample spread (min sample, js slice) beside a wall/INP median pinned to
  the frame floor, so a floored number is not read as "no difference".
