---
"@jantimon/web-performance-debugger": patch
---

Fix four terminal-output defects surfaced dogfooding against a production site:

- `query cpu` / `query span` / `cpu-diff` now compact an unmapped remote script URL (origin + truncated path, query string dropped) so a long third-party config URL no longer blows out the source column.
- The per-span compositor frame side track collapses its dropped/janky frames to a one-line count; `query spans`/`query span --frames` lists each. JSON output keeps every per-frame record.
- Drill-in hint lines print the recording as `latest` (or a cwd-relative path) instead of an absolute home/scratch path.
- `query span <measure>` discloses that rendering counts do not window to a `performance.measure` span, so a bar with real style/layout/paint ms beside `—` counts no longer reads as a contradiction.
