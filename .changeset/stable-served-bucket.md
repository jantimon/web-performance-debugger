---
"@jantimon/web-performance-debugger": patch
---

Fix: CPU frames from wpd's own bench-mode static server no longer bucket by its ephemeral
`127.0.0.1:<port>` origin. That port changes every run, so the same served code landed under a new
"package" each time and split cross-run `cpu-diff` / `functionJoinKey` joins. A served frame that
does not resolve to an on-disk source now maps its pathname back to the local file (the real
package/relative file), or falls back to the stable literal `(served)` bucket when no such file
exists. Genuinely remote origins, including a user's own dev server on `--url`, keep origin
bucketing.
