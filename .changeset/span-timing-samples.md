---
"@jantimon/web-performance-debugger": minor
---

Expose run and driver-step timing samples through `query span --format json|toon`.
The exported `SpanTiming` type names each sample's clock and boundary and keeps
measured statistics separate from the profiled bar window. Run-group members carry
their own timing blocks. Missing samples remain `null`.
