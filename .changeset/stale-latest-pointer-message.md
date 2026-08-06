---
"@jantimon/web-performance-debugger": patch
---

A stale `latest` now explains itself instead of surfacing a raw `ENOENT` on an internal path. When the
artifact the pointer names has been deleted, every consumer verb says which one is gone (recording,
CPU/allocation profile, or run-group manifest), shows its path the way the reports do, and names the
fix: record again, or pass an explicit path. A deleted run-group member names the member.
