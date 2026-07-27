---
"@jantimon/web-performance-debugger": patch
---

`query blame` rows now carry a representative event id for the `query get` drill. Each row (human
table and JSON `eventId`, plus the `query span` forced section) names the widest flush at that source
line, so `query get <id>` opens the raw event without a manual re-filter through `query events`.
Sampled `--breakdown` rows carry no id (their events are synthesized), shown as `—`, never a fake id.
