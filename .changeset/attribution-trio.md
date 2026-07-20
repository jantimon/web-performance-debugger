---
"@jantimon/web-performance-debugger": minor
---

Make CPU attribution and diff comparability honest for three real-world shapes:

- New `record --variant <label>`: when one module path runs several techniques (env-switched), label
  each so a `diff`/`cpu-diff --fail-on-regression` gate refuses to compare two different variants
  (or a labelled vs an unlabelled recording). Absent by default; old recordings compare as before.
- A dependency whose sourcemapped originals are off-disk (a common published-package shape) no longer
  splits its self-time across `(unmapped: <src-dir>)` buckets; it collapses to one bucket named for
  the package (a `@scope/name` pair, or the segment before `src`/`dist`/...), never `app`.
- A loopback host (127.0.0.1/localhost/[::1]) on an ephemeral `listen(0)` port no longer reads as a
  different workload each run: the port is folded for identity, so the same bench page keeps its gate.
  Non-loopback hosts and registered ports keep their port.
