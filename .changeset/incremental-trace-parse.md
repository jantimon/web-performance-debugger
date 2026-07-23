---
"@jantimon/web-performance-debugger": minor
---

Deep traces past the former ~512MB parse ceiling now parse. The trace is scanned one event at a time
straight from the raw stream bytes (`scanTraceEvents`), so a JS string is never built and a >512MB
trace no longer refuses with `tooLargeToParse`; a 1.09GB `--deep` trace parses in ~6s. The trace
buffer is raised to 4GB to match.

The next ceiling is honest: a `--deep`/firefox recording stores the full event log, and serializing
it to one JSON string still hits ~512MB. That failure is now a named, actionable error (the event
count and the `--breakdown` remedy), not a bare `Invalid string length`.
