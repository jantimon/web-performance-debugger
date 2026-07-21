---
"@jantimon/web-performance-debugger": patch
---

Close three ways a count gate could pass a broken CI green:

- `assert` on a run-group now gates a stepped driver member per step (matching a plain recording),
  not its run summary, so a per-step budget is not defeated by the run total.
- A cross-process split (successive navigations) or a dropped-event trace overflow is now recorded as
  a typed field (`meta.mainThread.split`, `meta.dataLoss.trace`); `assert` and `diff
  --fail-on-regression` refuse count and count-derived thresholds on such a recording (a loud
  not-gateable FAIL), never a silent pass over a known-incomplete count.
- A step whose work ran on an un-selected renderer process reports its counts as not-measured (—),
  never a fake 0.

Gates that were silently passing on these shapes now fail loudly; the message names the fix (one
navigation per run, or lighter work).
