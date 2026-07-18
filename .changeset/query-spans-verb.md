---
"@jantimon/web-performance-debugger": minor
---

**New: `query spans <file> [--label <L>]`: one unified per-span breakdown across every target.**
Returns one entry per span (the run window, each driver step, and every user `performance.measure`)
in a single slice shape (`js` with `byPackage`, `style`, `layout`, `paint`, `gc`, `other`, `idle`)
whether the recording came from chrome `--breakdown`, `--target firefox`, or `--target node`. A
slice a lane could not measure is an explicit `null`, never a fabricated `0`. `--label` filters to
one span by exact label. It sources the recording's stored per-span bars when present, else
synthesizes the `run` span from the CPU model's bar, so a recording carrying any bar is never empty.
New public types `SpansResult` / `SpanEntry` / `UnifiedSlices`; `query cpu --json` on Firefox now
hints at this surface.
