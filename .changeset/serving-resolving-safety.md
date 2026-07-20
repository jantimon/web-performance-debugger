---
"@jantimon/web-performance-debugger": patch
---

Tighten the serving and launch surfaces. The `--bench` static server no longer sends a wildcard
`Access-Control-Allow-Origin`: it grants CORS read access only to the one cross-origin host page a
remote `--url` bench run needs, so no other site open in your browser can read cwd files off the
loopback port while a run is live. It also rejects requests whose `Host` is not loopback, closing a
DNS-rebinding read. `--disable-browser-sandbox` now refuses to combine with `--user-data-dir` (an
unsandboxed renderer with your real profile has no safe use) and warns before launch when combined
with a public `--url`.
