---
"@jantimon/web-performance-debugger": patch
---

**Fixed: `--protocol-timeout` now works on `--target firefox`.** Under load Firefox can fail to
launch with `session.new timed out. Increase the 'protocolTimeout' setting` — advice you could not
take, because the CLI rejected that flag on Firefox as CDP-only. It is not one: raise it when
Firefox times out launching. That error no longer suggests measuring less work per step, which
cannot help when the browser never started.

**Fixed: `--bench`'s help said `run()` takes "no args", which reads as "no DOM".** It gets
`run(ctx)`, with live `document`/`window`, and pairs with `--html`/`--url` for a host page. The
README now says which mode to pick: `--bench` prices code the page runs, the driver measures a real
interaction.
