---
"@jantimon/web-performance-debugger": minor
---

Fix stepped (driver) runs silently reporting another step's numbers, or zeros

A stepped run records the flow twice (a clean timing pass and an instrumented trace pass) and
merges the two. That merge paired steps by their numeric index — but each pass replays the flow in
a fresh browser with its own counter, so index N in one pass and index N in the other are the same
step only by coincidence, and nothing verified it (the `wpd:step:N` markers carry no label).

When a flow took a different path in the two passes, index N could mean a different step in each:
one step inherited another step's trace window and reported its layout/paint/forced-layout counts,
while a step with no match reported **zero** for all of them. Zeros are indistinguishable from a
genuinely clean step, so `wpd assert --max-forced 0` passed on steps that were never measured.

Steps are now matched by label, and a disagreement between the passes is an error naming the
steps involved instead of a plausible-looking recording. The check runs before any artifact is
written, so a rejected run cannot leave a recording behind or move the `latest` pointer.

A lane that collects no trace windows at all (e.g. Firefox without `--cpu-profile`) is treated as
absence rather than disagreement and still records. Note that such a run reports `0` for every
trace-derived count, which `assert` cannot distinguish from a genuinely clean run — that gap is
unchanged here and is tracked separately.

**Breaking:** step labels must now be unique within a run. Repeated labels previously "worked"
(the index kept them apart) but produced a step index with two indistinguishable rows, and the
label cannot identify a step across passes if it is not unique. `record` now fails on the
offending `measureStep` call with a message naming the duplicate; disambiguate the labels
(e.g. `"mount@n=50"` / `"mount@n=400"`).

**Breaking:** `measureStep` now throws if called from `cleanup()`. Teardown runs after tracing
stops, so such a step was never traced and reported `0` for every trace-derived count as though
it were clean. Measure it in `run()` instead.
