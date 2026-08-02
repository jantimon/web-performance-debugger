// Sampled-blame probe: every geometry read forces a WIDE layout flush, so the --breakdown sampled
// read-site lands on the EXACT read line. Each read reflows a large subtree (thousands of inline
// boxes), so the flush runs longer than one CPU-sampler interval (~132-150us); per
// docs/dev/blame-semantics.md a flush wider than one interval yields the exact forcing line at ~100%
// recall, unlike the sub-interval flushes in forces-layout.mjs the same doc marks low-confidence and
// lets lag one statement. A slower host only widens the flush, so recall does not degrade under load

// In-page (bench) mode: this module is import()'d inside the browser, so document/window exist and
// source lines map to THIS file

let sink;
let toggle = 0;

// Dirty the whole subtree so the NEXT read reflows every box (a wide flush). The write only marks the
// tree dirty; the flush runs at the READ, where the sampler spends its whole width, so the sampled
// attribution lands on the read line, not the write
function invalidate(host) {
  toggle = (toggle + 1) % 2;
  host.style.fontSize = toggle ? "13px" : "12px";
}

export async function run() {
  const host = document.createElement("div");
  host.id = "wide-host";
  host.style.width = "800px";
  let markup = "";
  for (let box = 0; box < 1500; box++) {
    markup +=
      '<span style="display:inline-block;padding:2px">x' + box + " lorem ipsum dolor sit </span>";
  }
  host.innerHTML = markup;
  document.body.appendChild(host);

  // Settle the initial layout once so later reads measure only the forced reflow
  sink = host.offsetHeight;

  invalidate(host);
  sink = host.offsetHeight; // R:offsetHeight
  invalidate(host);
  sink = host.offsetWidth; // R:offsetWidth
  invalidate(host);
  sink = host.scrollHeight; // R:scrollHeight
  invalidate(host);
  sink = host.getBoundingClientRect().height; // R:getBoundingClientRect
  invalidate(host);
  sink = host.clientHeight; // R:clientHeight
  invalidate(host);
  sink = host.offsetTop; // R:offsetTop
  invalidate(host);
  sink = host.scrollWidth; // R:scrollWidth
  invalidate(host);
  sink = host.getClientRects().length; // R:getClientRects

  return { ok: true, sink: String(sink).slice(0, 10) };
}
