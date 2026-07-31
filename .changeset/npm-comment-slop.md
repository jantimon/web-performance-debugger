---
"@jantimon/web-performance-debugger": patch
---

The `no-comment-slop` lint rules now come from the released `eslint-plugin-no-comment-slop` npm
package, wired through `oxlint`'s `jsPlugins`, replacing the vendored copy. Comments that named the
`—` table placeholder had it swapped for a plain `-`, misdescribing the output; those are restored
to the real glyph (backtick-wrapped where needed). Internal only, no runtime or output change.
