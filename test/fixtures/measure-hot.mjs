// A bench module (run() executes inside the page) with two user `performance.measure` spans: a heavy
// one whose pooled CPU samples clear the per-span hot-list floor (a named function dominates), and a
// trivial one whose window stays below it (the ranked list is suppressed). Drives the --breakdown
// per-span hot functions end to end: query span measure:heavy shows a hot list; measure:trivial is
// suppressed.

function heavyWork() {
  let sink = 0;
  for (let iteration = 0; iteration < 4_000_000; iteration++) sink += Math.sqrt(iteration + 1) * 1.0001;
  return sink;
}

export function run() {
  performance.mark("heavy:start");
  const sink = heavyWork();
  performance.mark("heavy:end");
  performance.measure("heavy", "heavy:start", "heavy:end");

  // A tiny but non-empty window: enough that the measure has a real span, far too little to gather
  // the ~10 pooled samples the hot-list floor needs.
  performance.mark("trivial:start");
  let tiny = 0;
  for (let iteration = 0; iteration < 2000; iteration++) tiny += iteration % 3;
  performance.mark("trivial:end");
  performance.measure("trivial", "trivial:start", "trivial:end");

  return { sink: Math.round(sink), tiny };
}
