---
"@jantimon/web-performance-debugger": minor
---

Add **run groups**: record several capture modes of one workload as siblings under a
`<name>.group.json` manifest, the sanctioned two-question path.

- `record … --members breakdown,deep --group <name>` records each mode back to back into one group;
  `record … --group <name>` appends a single recording (the join refuses a member whose
  workload/iterations/browser/etc differ — only the capture mode may).
- `query spans`/`query span`/`assert`/`diff` accept a manifest (or `latest`): `query span` STITCHES
  one anatomy across members (bar+hot from the breakdown member, counts+forced from the deep member,
  every panel tagged and each member's wall shown separately); `assert` routes each threshold to the
  member that measured its axis, with a loud `n/a` FAIL where none did; `diff` fans out over members
  paired by capture mode. The manifest holds no aggregate of its own — nothing is averaged across
  members. Old recordings and pointers are unaffected (a new artifact kind at the same schema).
