---
"@jantimon/web-performance-debugger": minor
---

Chrome now launches with its OS sandbox ENABLED by default; `--no-sandbox`/`--disable-setuid-sandbox`
are no longer passed on every run. To launch anyway in an environment that cannot start the sandbox
(containers, restricted CI), pass the new `--disable-browser-sandbox` flag, which restores both args
with a loud WARNING in `meta.notes` and on stderr. If a sandboxed launch fails, wpd reports the
sandbox error and names the flag rather than silently retrying unsandboxed. Firefox is unaffected.
