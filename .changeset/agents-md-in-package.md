---
"@jantimon/web-performance-debugger": patch
---

AGENTS.md now ships in the npm package, so it lands at
`node_modules/@jantimon/web-performance-debugger/AGENTS.md` for a consumer to read. `wpd --help` ends
with the absolute paths to the installed AGENTS.md and README.md, so an agent can find and open them.
