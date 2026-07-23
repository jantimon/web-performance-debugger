---
"@jantimon/web-performance-debugger": patch
---

The terminal report now carries provenance at a glance, so a number is harder to misquote. JSON/TOON
output is unchanged.

- `query span` tags a settle/idle-dominated wall with its idle share (`~88% idle (window, not work)`),
  so a boot window's width is not read as workload cost.
- A step's wall on `query span` now names itself a median of its samples, since the header
  aggregation (`first`) describes the counts/bar window, not the wall.
- Over-wide span labels and source paths/URLs in the tables are middle-ellipsized so a real-site cell
  cannot blow the column layout.
