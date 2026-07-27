---
"@jantimon/web-performance-debugger": patch
---

Drop the legacy in-cwd `recordings/.wpd-last.json` fallback when resolving `latest`. The pointer
lives under the XDG state dir; a stale in-cwd file is ignored. If `latest` no longer resolves, run
`record` once to write the pointer.
