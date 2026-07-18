---
"@jantimon/web-performance-debugger": minor
---

**New: a reconciling CPU-time breakdown bar, `js · browser · gc · idle`.** It tiles the sampled
window exactly (the slices sum to wall, with `js` split by package) and appears in the `record`
report, in `query cpu` (human and `--json`/`--format`), and as an additive optional `breakdown`
field on the `.cpu.json` model. Firefox reports its own six-slice bar (`js · style · layout ·
browser · gc · idle`, see its changeset entry); `--target node` measures pure JS. Old `.cpu.json`
files without the field keep working.
