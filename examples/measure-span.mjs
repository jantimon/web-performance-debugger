// The mark bridge: a slice of work wrapped in performance.mark/measure becomes its own reconciling
// span (recording.spans, kind "measure"), attributed the same way as the whole run. Bench mode:
// run() executes inside the page, so document/window/performance are all live.
// Run: node dist/cli.js record examples/measure-span.mjs --bench --target firefox --iterations 5
//      node dist/cli.js query spans latest             # the "work" measure span alongside the run
//      node dist/cli.js query span latest work         # its full anatomy (bar + hot functions)

export async function run() {
  const host = document.createElement("div");
  host.innerHTML = '<div id="mbox" style="width:100px;height:100px;border:1px solid #000">x</div>';
  document.body.appendChild(host);
  const box = document.getElementById("mbox");

  performance.mark("work:start");
  // Enough real JS that the span clears the ~1 ms Gecko sampler floor at a few iterations (a sub-ms
  // window would sample zero JS and the bar would read all-idle), plus one forced geometry read so
  // the span carries js + layout, not just idle.
  let sink = 0;
  for (let index = 0; index < 6000000; index++) sink += Math.sqrt(index);
  box.style.width = 100 + (sink % 40) + "px";
  sink += box.offsetWidth;
  performance.mark("work:end");
  performance.measure("work", "work:start", "work:end");

  document.body.removeChild(host);
  return { sink: Math.round(sink) };
}
