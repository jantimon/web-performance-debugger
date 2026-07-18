// Near-zero probe: run() does almost nothing, one console.log and a trivial return. Backs the
// sampler-resolution-floor finding in docs/dev/cpu-profiling.md: a sub-millisecond call can land
// zero samples at low --iterations (Chrome reads js 0 around iter 10 and only becomes monotonic
// above ~200 iterations; Firefox's ~1ms floor reports a fixed ~5ms of a handful of samples). Raise
// --iterations until the number stabilises.
// Run: node dist/cli.js record examples/near-zero.mjs --bench --iterations 250
//      node dist/cli.js query cpu latest

export function run() {
  console.log("near-zero probe: one log and a trivial return");
  return 1;
}
