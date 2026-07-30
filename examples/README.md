# Examples

## Start here

Three demos show the main lanes. Build wpd first (`npm run build` at the repo root), then:

**Forced-layout blame (bench).** A read-after-write loop that forces a synchronous layout every
iteration; `query blame --forced` names the source line that read geometry.

```bash
wpd record examples/forces-layout.mjs --bench --iterations 5
wpd query blame latest --forced
```

**A driven interaction (driver).** Clicks a real React app and reports each step. Build the app once
first (`cd examples/react-counter && npm install && npm run build`), then:

```bash
wpd record examples/counter-steps.mjs --url examples/react-counter/dist/index.html
wpd query spans latest
```

**SSR CPU self-time (node).** Attributes `renderToString` self-time to react-dom vs a styling library
vs your component, down to a line. Install the demo's deps first (`cd examples/ssr-demo && npm install`):

```bash
NODE_ENV=production wpd record examples/ssr-demo/demo.mjs --target node --iterations 250
wpd query cpu latest
```

## The rest

The other files (`near-zero.mjs`, `flaky-iteration.mjs`, `capture-mode-speed.mjs`, `gecko-overhead.mjs`,
and the like) are measurement probes: the test suites and the `docs/dev/` experiments drive them to
pin down numbers and edge cases. They are calibration fixtures, not tutorials.
