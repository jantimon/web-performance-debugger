---
"@jantimon/web-performance-debugger": patch
---

Fold the `structuredFormat`/`emit` copies in `commands/cpu` and `commands/cpudiff` onto the shared
`output/format` helper; their option interfaces now extend `StructuredOutOpts`. No CLI output changes.

Docs: a "how many runs" note where `--iterations` is documented (the median of a few runs is far
steadier than one; `--iterations 5` is the calibration knob), and a CI caution against running two
measurement processes at once on one machine.
