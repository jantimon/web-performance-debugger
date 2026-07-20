---
"@jantimon/web-performance-debugger": patch
---

**`query cpu --by package` no longer blames a dependency's cost on "app".** When a sourcemap remaps a
frame to an original source that is not on the recorder's disk (a dependency built from a
workspace/source checkout, or a stale map), the resolver used to fs-walk that phantom path up to the
nearest `package.json` and land on the user's own root, so the dependency read as `app`. It now
derives the owner from the path string: the `node_modules` package the phantom source or its bundle
url names, else an honest `(unmapped: <dir>)` bucket, never `app`. The frame is flagged so the
sourcemap warning fires. Frames that were never remapped (the app's own source) are unaffected.
