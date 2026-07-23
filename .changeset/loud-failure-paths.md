---
"@jantimon/web-performance-debugger": patch
---

Failures now surface loudly and clean up after themselves:

- A static-server bind failure (port in use, EPERM) fails the run through the normal `record failed:`
  path with exit 1, instead of crashing on an uncaught error.
- A teardown failure (a cleanup hook, a browser close) no longer replaces the primary run error; the
  run error surfaces and the teardown failure is attached as its `cause`.
- The Firefox lane no longer leaves its multi-MB temp profile dump behind when a run, parse, or copy
  fails.
- A browser launch that fails partway through setup (new page, CDP session) closes the browser
  instead of leaving it running.
