---
"@jantimon/web-performance-debugger": major
---

**Breaking: schema 5.** Recordings from earlier versions refuse to open with a re-record message. Re-record any stored baselines after upgrading. CLI commands and flags are unchanged, and measurement semantics are unchanged.

Raw-JSON (recording) consumers:

- The `summary` object is **gone**. The run-level counts, wall, INP, longest-task duration and per-iteration stats now live on the **run span** (`spans[]` with `kind: "run"`); each driver step carries its own on its step span. Read counts from `run.counts`, timing from `run.wallMs`/`run.inpMs`/`run.perIteration`/`run.stats`.
- Wall fields are named by clock: a span's page-clock headline stays `wallMs` (with `wallClock: "page" | "trace"` on every span whose wall is set), while the trace-clock window a reconciling bar tiles is `breakdown.wallMs`.
- `meta.passes: string[]` is now `meta.capture: string` (the one capture mode).
- `meta.driver` and `meta.runtime` are removed; derive them from `meta.workload.lane` (`"driver"`/`"builtin-load"` are driver mode, `"node"` is the node runtime).
- `summary.jsSelfMs` moved to `meta.jsSelfMs`; `summary.totalEvents` moved to `meta.totalEvents`.

`query … --format json` consumers: the step `SpanEntry`/`SpanAnatomy` field `breakdownWallMs` is renamed to `windowMs`; `SpanCounts` gains `paintInvalidations`.
