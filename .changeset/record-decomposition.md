---
---

Internal refactor only, no release. `RecordOptions` moves to `src/record/options.ts` (re-exported
from `commands/record.ts`, so every import path stays valid), breaking the four type-only import
cycles between `commands/record.ts` and its `record/` implementation files. `record()` splits into
nine sequential phase helpers so the function reads as a table of contents; output and artifacts are
byte-identical.
