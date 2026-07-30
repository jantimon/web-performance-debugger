---
"@jantimon/web-performance-debugger": minor
---

Surface framework facts without drilling:

- `query spans` overview rows now carry a compact `addons.react` (`version` + `build`), so a bulk consumer reads framework identity off the overview instead of opening each span. The full per-span facts (commit counts, server phases) stay on `query span`.
- Recordings now stamp `meta.framework` (`"off" | "auto"`), so a deliberate `--framework off` run is distinguishable from an `auto` run that detected no framework (both carry no `Span.addons`).
