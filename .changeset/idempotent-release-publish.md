---
"@jantimon/web-performance-debugger": patch
---

Release job no longer fails when the current version is already on npm. A push to main with no pending
changesets re-attempts the current version; the publish step now treats "already published at this
version" as a no-op success and fails only on a genuine publish error.
