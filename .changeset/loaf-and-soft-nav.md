---
"@jantimon/web-performance-debugger": minor
---

**Per-step Long Animation Frame attribution (Chrome).** A driver step now carries the Long Animation
Frames it triggered, naming the scripts that made a frame slow (the listener/callback, its script url,
its duration, and the ms it forced in style/layout). The in-page observer is ungated, so a step gets
script-level attribution even on the default rung (no trace, no CPU sampler window) and where the
sampler could not reach. `query span <step>` prints the blamed scripts. Firefox has no LoAF API, so a
Firefox step omits it rather than reporting a fake zero.

**`waitForStable` completion helper for streamed / soft navigations.** A new exported `measureStep`
`until` waits for a selector and then for the DOM to stop mutating, catching a streamed route
transition the default settle can end before. Opt-in, since it trades a longer wall for catching the
whole transition.
