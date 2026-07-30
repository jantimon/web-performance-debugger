// A small allocation workload for the --alloc node lane: run() allocates a mix of short-lived
// strings, objects and arrays (dropped every call, so a GC reclaims them). With the GC-inclusion
// flags on, the heap sampler attributes those bytes to the functions below, under the "app" package
// (this module is outside node_modules). Deliberately dependency-free so it runs from a clean checkout
//
// Run:  node dist/cli.js record examples/probes/allocates.mjs --target node --alloc --iterations 20
//       node dist/cli.js query alloc latest

function buildStrings(count) {
  const strings = [];
  for (let index = 0; index < count; index++) strings.push(("payload-" + index + "-").repeat(6));
  return strings;
}

function buildObjects(count) {
  const objects = [];
  for (let index = 0; index < count; index++)
    objects.push({ a: index, b: index * 3, c: "x".repeat(24), d: [index, index + 1] });
  return objects;
}

export function run() {
  let sink = 0;
  const strings = buildStrings(1500);
  const objects = buildObjects(1500);
  sink += strings.length + objects.length;
  return sink;
}
