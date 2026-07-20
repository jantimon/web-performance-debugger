---
"@jantimon/web-performance-debugger": patch
---

`query spans` gains two filters for when a tag manager floods the overview with hundreds of tiny
`performance.measure` spans: `--min-wall <ms>` hides spans below a wall threshold, and `--filter <text>`
keeps only labels containing `<text>` (case-insensitive substring). Both combine with `--label` and with
each other, and the output always states how many spans the filter hid, so a filtered view is never
mistaken for the whole recording.
