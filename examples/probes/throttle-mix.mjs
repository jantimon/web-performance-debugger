// Throttle-attribution probe (in-page --bench): two named functions with DISTINCT cost profiles that
// compete for the same CPU-self-time 100%, so their SHARES expose whether --cpu-throttle scales work
// uniformly. `jsLoop` is pure JS (a fixed integer loop, no DOM). `layoutThrash` is JS + the
// synchronous engine work it forces (a read-after-write reflow over 25 boxes), which the browser-lane
// sampler bills to the forcing line (~85% of its self-time is Blink reflow C++, not JS). If CDP CPU
// throttling multiplies both alike, the two shares hold at 1x and 4x; if reflow throttles differently
// than JS, the split moves. Sized so each function is ~40-50% at 1x, leaving room to see a shift.
// Run: node dist/cli.js record examples/probes/throttle-mix.mjs --bench --iterations 5 [--cpu-throttle 4]
//      node dist/cli.js query cpu latest --by function

const JS_LOOP_ITERATIONS = 1_600_000;

function jsLoop() {
  let accumulator = 0;
  for (let index = 0; index < JS_LOOP_ITERATIONS; index++) {
    accumulator = (accumulator * 31 + index) | 0;
  }
  return accumulator;
}

function layoutThrash(boxes) {
  let sink = 0;
  for (let round = 0; round < 22; round++) {
    for (const box of boxes) {
      box.style.width = 100 + (round % 50) + "px";
      box.style.paddingLeft = (round % 7) + "px";
      sink += box.offsetWidth; // forced synchronous layout on this line
      sink += box.getBoundingClientRect().height; // forced synchronous layout on this line
    }
  }
  return sink;
}

export function run() {
  let host = document.getElementById("wpd-throttle-mix-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "wpd-throttle-mix-host";
    let markup = "";
    for (let boxIndex = 0; boxIndex < 25; boxIndex++) {
      markup +=
        '<div class="wpd-mix-box" style="width:100px;height:40px;border:2px solid #333;' +
        'padding:2px;position:relative;overflow:scroll">' +
        '<div style="width:300px;height:300px"></div></div>';
    }
    host.innerHTML = markup;
    document.body.appendChild(host);
  }
  const boxes = host.querySelectorAll(".wpd-mix-box");
  const jsResult = jsLoop();
  const thrashResult = layoutThrash(boxes);
  return (jsResult + thrashResult) | 0;
}
