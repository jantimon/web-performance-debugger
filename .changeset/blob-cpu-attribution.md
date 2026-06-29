---
"@jantimon/web-performance-debugger": patch
---

cpu: attribute `blob:` scripts to a `(blob)` package instead of mis-blaming an unrelated package.

A same-process iframe built from a Blob (e.g. an embedded dashboard) reports `blob:` script URLs.
These are not on disk and not fetchable, but they previously fell through to the local-path branch,
where package resolution walked the filesystem up to the nearest `package.json` and mis-attributed
the iframe's CPU self-time to an unrelated package (often wpd's own). They now bucket as `(blob)` in
`query cpu`. Function names stay minified (blob bundles carry no fetchable sourcemap).
