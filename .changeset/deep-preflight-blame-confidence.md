---
"@jantimon/web-performance-debugger": patch
---

A heavy `--deep` capture now fails fast with a named error the moment the trace is captured, above a
180MB trace floor, instead of crashing with a raw V8 out-of-memory during the parse. The refusal (and
the `writeRecording` backstop) now also names fewer `--iterations` as a way to shrink the stored event
log.

`query blame --forced` JSON/TOON rows carry a three-way `lowConfidence`: `true` (sampled, sub-interval),
`false` (sampled, confident), absent (not a sampled row), so a consumer can tell a confident sampled
read from a `--deep`/firefox exact one.
