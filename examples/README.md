# Examples

One rule for this folder: the files at the top level are **demos you run**; everything under
[`probes/`](probes/) is a **measurement fixture** the test suites and the `docs/dev/` experiments
drive, not a tutorial.

Build wpd first (`npm run build` at the repo root). Each demo below answers one question.

## Demos

**Which source line forces a synchronous layout?** (bench)
A read-after-write loop that forces a layout every iteration; `query blame --forced` names the read.

```bash
wpd record examples/forces-layout.mjs --bench --iterations 5
wpd query blame latest --forced
```

**What does each interaction cost?** (driver)
Clicks a real React app and reports each step. Build the app once first
(`cd examples/react-counter && npm install && npm run build`):

```bash
wpd record examples/counter-steps.mjs --url examples/react-counter/dist/index.html
wpd query spans latest
```

**Where does `renderToString` spend its time?** (node)
Attributes SSR self-time to react-dom vs a styling library vs your component, down to a line. Install
the demo's deps first (`cd examples/ssr-demo && npm install`):

```bash
NODE_ENV=production wpd record examples/ssr-demo/demo.mjs --target node --iterations 250
wpd query cpu latest
```

**How do I price one named slice of work?** (the `performance.measure` bridge)
Wraps a slice in `performance.mark`/`measure` so it becomes its own span, attributed like the whole run.

```bash
wpd record examples/measure-span.mjs --bench --iterations 5
wpd query span latest work
```

[`demo-gif/`](demo-gif/) holds the VHS tape behind the README hero recording; its own README has the
render steps.

## probes/

The files under [`probes/`](probes/) are calibration fixtures. The test suites and the `docs/dev/`
measurement notes drive them to pin down numbers and edge cases (`near-zero.mjs`, `flaky-iteration.mjs`,
`capture-mode-speed.mjs`, `gecko-overhead.mjs`, and the like). They are not tutorials. `sample-module.mjs`
and `sample.html` are the bare module template plus a host page, showing the `run`/`prepare`/`cleanup`
contract.
