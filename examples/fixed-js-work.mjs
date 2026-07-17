// Fixed small-JS-work probe: run() spends a deterministic ~1.5ms in a plain integer loop, with no
// DOM and no waiting. Backs the "sub-frame CPU work IS measurable" measurement in
// docs/dev/cpu-profiling.md: this sub-frame call is invisible to wall/INP (below one display frame)
// but the CPU sampler prices it, and js self-time reconciles with the --bench wall to ~1-3%.
// Run: node dist/cli.js record examples/fixed-js-work.mjs --bench --iterations 50
//      node dist/cli.js query cpu latest

const LOOP_ITERATIONS = 1_500_000;

export function run() {
  let accumulator = 0;
  for (let index = 0; index < LOOP_ITERATIONS; index++) {
    accumulator = (accumulator * 31 + index) | 0;
  }
  return accumulator;
}
