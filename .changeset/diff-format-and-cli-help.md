---
"@jantimon/web-performance-debugger": minor
---

`diff` gains `--format json|toon` (and the hidden `--json` alias): the same field-by-field
comparison, comparability warnings, gated regressions and per-span slice deltas as the human report,
serialized as a `DiffView` (a `GroupDiffView` for a run-group diff). Human output and
`--fail-on-regression` exit codes are unchanged. New exported types: `DiffView`, `DiffMetricRow`,
`GroupDiffView`, `DiffOutput`.

CLI help polish: the top-level tagline names all three targets and CPU self-time; `--help` and
`record --help` gain quick-start epilogs; `query events --kind` lists the missing `gc`; `query get`
accepts the shared `--json` alias; `--breakdown`/`--deep` help notes their mutual exclusivity and
where to read the result.
