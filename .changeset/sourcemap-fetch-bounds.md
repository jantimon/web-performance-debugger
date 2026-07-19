---
"@jantimon/web-performance-debugger": patch
---

Bound the remote sourcemap fetcher for `--url` runs: a per-run 30s budget, per-response size caps
(20MB scripts / 50MB maps, enforced by streaming so a missing content-length cannot overrun),
bounded-concurrency fetching (4 at a time instead of strictly serial), and a network policy that
follows redirects manually and refuses non-http(s) schemes and private/loopback hosts reached from a
public page. Refused, oversized, and budget-exhausted lookups each record their own `meta.sourcemaps`
diagnostic; localhost dev servers and served fixtures are unaffected.
