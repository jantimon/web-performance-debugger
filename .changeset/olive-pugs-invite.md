---
"@jantimon/web-performance-debugger": minor
---

**Breaking: `--runtime` and `--browser` are replaced by one `--target chrome|firefox|node`.** Rename
`--runtime node` to `--target node`, and `--browser firefox` to `--target firefox`.

**Breaking: `--cpu-profile` is gone and CPU profiling is on by default on every target.** Drop the
flag from your commands. `--no-cpu-profile` opts out on chrome only; firefox and node refuse the flag,
because on those targets it would leave nothing to measure. Profiling costs no extra pass, but it
adds ~10% to reported wall time, so pass `--no-cpu-profile` when you need absolute wall numbers.

**Breaking: `--target node --bench` is now an error** instead of being silently ignored. `--bench`
imports the module inside a page and the node target has no page; `--iterations` already repeats
`run()` there.

`--cpu-interval` now defaults to 200us instead of 50us on every target.

Fixed: a firefox run without `--cpu-profile` used to report every rendering count as `0`,
indistinguishable from a clean run; `--target firefox` now yields counts and blame with no extra flag.
The "no sourcemap resolved" warning no longer fires for plain unbundled source, which needs no map,
and new `SourceMapDiagnostics.unmappedBundles` / `CpuModel.unmappedFrames` report what a missing map
actually costs you. With `--no-trace`, `meta.notes` no longer describes a trace pass that never ran.
A trace-window warning told you to raise `--settle-ms`, which is not a flag; the flag is `--settle`.
The `record` report now prints artifact paths relative to the current directory when that is shorter;
the paths stored inside the artifacts stay absolute, so `latest` still reopens from any directory.
