---
"@jantimon/web-performance-debugger": patch
---

Fix: an unmapped CPU frame served from an ephemeral `127.0.0.1:<port>` origin no longer buckets by
that port. A `--bench --url` run (or any local dev server on a `listen(0)` port) gets a new port
every run, so a frame whose sourcemap loaded but position-missed landed under a fresh
`(127.0.0.1:<port>)` "package" each time and split every cross-run `cpu-diff` / `functionJoinKey`
join, including the `--breakdown` and firefox `jsByPackage` splits. Ports in the ephemeral range now
drop out of the bucket (`(127.0.0.1)`); a registered port like `:3000` names a real service and
stays. A frame from wpd's own served origin whose sourcemap points at an off-disk source resolves to
the served file, or the stable `(served)` bucket.
