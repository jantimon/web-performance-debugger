// The §14 mark bridge: a slice of work wrapped in performance.mark/measure becomes its own
// reconciling breakdown span, attributed the same way as the whole run. Bench mode: run() executes
// inside the page, so document/window/performance are all live.
// Run: node dist/cli.js record examples/measure-span.mjs --bench --target firefox --iterations 5
//      node dist/cli.js query digest latest --json   (see recording.breakdowns, kind "measure")

export async function run() {
  const host = document.createElement("div");
  host.innerHTML = '<div id="mbox" style="width:100px;height:100px;border:1px solid #000">x</div>';
  document.body.appendChild(host);
  const box = document.getElementById("mbox");

  performance.mark("work:start");
  // Some real JS plus one forced geometry read, so the span carries js + layout, not just idle.
  let sink = 0;
  for (let index = 0; index < 300000; index++) sink += Math.sqrt(index);
  box.style.width = 100 + (sink % 40) + "px";
  sink += box.offsetWidth;
  performance.mark("work:end");
  performance.measure("work", "work:start", "work:end");

  document.body.removeChild(host);
  return { sink: Math.round(sink) };
}
