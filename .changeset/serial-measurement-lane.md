---
---

Split the browser-free `--target node` measurement tests into a serial lane
(`test/measurement/`, `npm run test:measurement`, `--test-concurrency=1`) so they never record while
parallel unit workers compete for the CPU. Test/infra only; no package change.
