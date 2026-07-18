---
"@jantimon/web-performance-debugger": minor
---

**New: `--breakdown` records a per-span off-thread frame side track (Chrome).** Each span now carries
`frames` with the compositor's PipelineReporter verdicts: `presented` / `partial` / `dropped` /
`no-update` counts, per-frame records, and the slowest presented (incl. partial) frame's top
pipeline-stage durations. The `record` report and `query digest` print a compact line under each bar
(`frames: N presented · N partial · N dropped`), and name any dropped or smoothness-affecting frame.

This comes from data already in every Chrome trace (the enabled
`disabled-by-default-devtools.timeline.frame` category); no trace-config change. It is DISPLAY-ONLY:
frame counts are scheduler/settle noise (see docs/dev/rendering-counts.md), so `assert` and `diff`
never gate on them; `Paint` stays the only exact rendering count. Nothing here is summed into a
breakdown bar. Additive: recordings without the field still load.
