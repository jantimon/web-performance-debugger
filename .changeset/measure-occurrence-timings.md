---
"@jantimon/web-performance-debugger": minor
---

Keep the timing series for repeated named measures in capture order and expose it
through `query span --format json|toon`. The timing block uses
`sampleUnit: "occurrence"`, since one iteration can produce several measures with the same name.
The profile bar keeps its actual lower-median occurrence; its slices are not averaged.
