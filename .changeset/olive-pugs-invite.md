---
"@jantimon/web-performance-debugger": minor
---

**Breaking:** `--runtime` and `--browser` are replaced by one `--target chrome|firefox|node`.
Rename: `--runtime node` → `--target node`, `--browser firefox` → `--target firefox`.

**Breaking:** `--cpu-profile` is gone; CPU profiling is on by default on every target. Drop the flag
from your commands. `--no-cpu-profile` opts out (chrome only — it is refused on firefox and node,
where it would leave nothing to measure). This costs no extra pass: the sampler now rides the timing
pass, so a `record` run is still 2 passes. It does add ~10% to reported wall time, which is
systematic and cancels in `diff`; use `--no-cpu-profile` for absolute wall numbers or `--iterations`
benchmarking.

**Fixed:** a Firefox run without `--cpu-profile` used to report every rendering count as `0` —
indistinguishable from a clean run. `--target firefox` now yields counts and blame with no extra flag.

**Fixed:** `--cpu-interval` now defaults to 200us instead of 50us. The old default inflated its own
measurement ~6% and wall ~8.5%, while resolving no functions the new one misses.

**Fixed:** a trace-window warning told you to raise `--settle-ms`, which is not a flag. It is `--settle`.

**Fixed:** the "no sourcemap resolved … CPU self-time is attributed to minified bundle names" warning
fired on runs that took no CPU profile.

Docs: forced-layout blame is **not** engine-comparable — Chrome names the geometry read that forced
the flush, Firefox names the write that dirtied the DOM. Compare each engine against itself, and use
`query cpu` to compare across engines. Relatedly, `self ms` in a browser is JS *plus the synchronous
engine work it triggered*, so a forced layout is billed to the line that forced it; only
`--target node` measures pure JS.
