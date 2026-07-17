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

**Breaking:** `--target node --bench` is now an error instead of being silently ignored. `--bench`
imports the module inside a page; the node lane has no page. `--iterations` already repeats `run()` there.

**Fixed:** `--cpu-interval` now defaults to 200us instead of 50us, on every target. The old default
inflated its own measurement ~6% and wall ~8.5%, while resolving no functions the new one misses.

**Fixed:** the "no sourcemap resolved … CPU self-time is attributed to minified bundle names" warning
fired whenever no sourcemap resolved — including for plain unbundled source, which needs no map and
whose frames resolve fine. It now fires when a missing map actually costs you something: an unmapped
script that is minified build output, or a frame with no determinable owner. `SourceMapDiagnostics`
gains `unmappedBundles` and `CpuModel` gains `unmappedFrames` so you can see how much.

**Fixed:** with `--no-trace`, the notes claimed counts came from "a separate heavy-instrumentation
pass" that never ran, and a warning blamed a trace-buffer overflow — for a run with tracing
deliberately off.

**Fixed:** a trace-window warning told you to raise `--settle-ms`, which is not a flag. It is `--settle`.

**Fixed:** the `record` report printed artifact paths absolute, which wrapped across lines and put
your home directory into anything you pasted or screenshotted. They now print relative to the current
directory when that is shorter. The paths stored *inside* the artifacts stay absolute, so `latest`
and the back-pointers still reopen from any directory.

Docs: forced-layout blame is **not** engine-comparable — Chrome names the geometry read that forced
the flush, Firefox names the write that dirtied the DOM. Compare each engine against itself, and use
`query cpu` to compare across engines. Relatedly, `self ms` in a browser is JS *plus the synchronous
engine work it triggered*, so a forced layout is billed to the line that forced it; only
`--target node` measures pure JS.
