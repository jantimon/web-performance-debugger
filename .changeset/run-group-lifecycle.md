---
"@jantimon/web-performance-debugger": patch
---

Harden the run-group lifecycle so a re-record cannot corrupt a good group.

- A `--group`/`--members` record now validates every requested member against any existing
  manifest BEFORE launching a browser or writing a byte: a duplicate member, or a `--group`
  name that only sanitize-collides with a stored one, refuses (exit 1) and names the recovery.
- The group pointer is written only after the join is accepted, so a refused join leaves
  `latest` on the prior group instead of downgrading it to an orphan recording.
- A recovered partial group loses its stale "the deep capture failed" note: partial status is
  derived from requested-vs-present members, so the note reflects the current state.
- Artifact and manifest writes are atomic (temp file + rename), so a kill mid-write cannot
  corrupt an existing recording, CPU model, manifest, or the `latest` pointer.
- Export the run-group manifest and stitched group-query types from the package root
  (`RunGroup`, `GroupMember`, `GroupSpansResult`, `GroupSpanStitch`, `SpansOutput`, …).
