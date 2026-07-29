---
"@jantimon/web-performance-debugger": minor
---

React framework addon, opt-out via `--framework off|auto` (default `auto`):

- **Detection + commit counts** on the browser lanes (dev and production alike): React present/version/renderer/build from a pre-load hook, plus an exact per-step commit count. Ride the run span and each step span under `Span.addons.react`.
- **Node-lane server phases** (`--target node`): react-dom self-time rolled onto the stable server-phase anchors. React 19 production resolves them; React 18 production is mangled, so the fact is honestly absent.
- **React Performance Tracks** on chrome `--deep` dev builds (`Span.addons["react-dev"]`), classified from the `TimeStamp` events wpd already stores. A production browser build emits none, so this is absent there.

`--framework off` runs zero addon code and leaves the recording unchanged. All React logic lives behind one registry interface the core never imports through; addons only read what the capture recorded. `query span` shows a labeled `React (addon)` block; `--format json` adds an `addons` object. New public types: `ReactFacts`, `ReactDevFacts`, `SpanAddons`, `FrameworkMode`.
