---
---

Docs and internal cleanup, no package change: promote several in-comment measured constants into
`docs/dev` sections and ledger rows (the Firefox idle-CPU cutoff, the cpu-diff resolving floor, the
settle stall ceiling, and the remote-sourcemap fetch caps); state the `NAV_RETRY_LIMIT` reasoning;
clarify that the artifact schema gate guards the schema epoch (the stored shape), not field presence,
and document the going-forward gate-field invariant; and dedup the ephemeral-port range constants into
one shared definition.
