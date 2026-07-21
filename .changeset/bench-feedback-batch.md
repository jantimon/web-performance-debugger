---
"@jantimon/web-performance-debugger": patch
---

Faster Firefox capture turnaround: the shutdown-dump poll now confirms the dump in a few tight reads instead of a fixed ~750 ms floor (the dump is already complete when `browser.close()` resolves), so every `--target firefox` run finishes sooner.

`record --group` now refuses a member whose `--out` collides with an existing member's recording, instead of silently overwriting it and leaving two manifest entries pointing at one file. The group overview (`query spans`) and the stitched `query span` also fail loudly when a member file's capture mode no longer matches the manifest, rather than returning undefined slices. Give each member a distinct `--out`, or use `--members <modes> --group <name>` to auto-name them.
