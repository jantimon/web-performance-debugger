---
"@jantimon/web-performance-debugger": minor
---

Add `--alloc`: a node-lane allocation-attribution capture mode. `wpd record <module> --target node
--alloc` runs V8's heap sampler (GC-inclusive) around your `run()` loop and attributes allocated bytes
to source/package, answering "which dependency allocates". Read it with the new `query alloc --by
package|file|function`. It is a dedicated mode with the CPU sampler OFF (a co-riding heap sampler
inflates CPU self-time), so an `--alloc` recording carries no CPU model; `query cpu`/`cpu-diff` on one
point you at `query alloc`. Byte shares/ratios are trustworthy (~5%); the absolute total is directional
(~10-20%).
