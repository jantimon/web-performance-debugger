---
"@jantimon/web-performance-debugger": minor
---

Per-soft-step route web vitals (Chrome 151+). When a driver step soft-navigates and Chrome's heuristic fires, the step now carries the route transition's own LCP-equivalent, CLS, and INP in `step.softNav`, keyed by the soft nav's `navigationId` and anchored to the route clock: `routeLcp` (`tag`/`url`/`size`, `routeMs` into the route), `routeCls` (the post-route shifts, spec session-window max), and `routeInpMs`/`routeInteraction` (the worst interaction after the route; the triggering click keeps the pre-nav id and stays in the step's main `inp`). `query span <step>` prints them under the step. Opportunistic and additive: a programmatic or untrusted-click route, older Chrome, and Firefox/node fire no engine entry, so `softNav` is absent, never a fabricated 0. No new flags; schema stays 5.
