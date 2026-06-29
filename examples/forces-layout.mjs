// Dogfood test: per-entry forced-layout probe for the entries in Paul Irish's
// "what forces layout" gist.
//
// Strategy: for each entry we (1) invalidate layout by mutating geometry,
// then (2) access the entry ON ITS OWN SOURCE LINE so the profiler can
// attribute any synchronous (forced) Layout to that exact line.
//
// In-page mode: this whole module is import()'d and executed INSIDE the
// browser, so document/window are available and source lines map to THIS file.

let sink; // prevents the read from being treated as dead
let bumpN = 0;
function bump(el) {
  // dirty layout: unique width each call
  bumpN = (bumpN + 1) % 400;
  el.style.width = 100 + bumpN + "px";
  el.style.height = 50 + bumpN + "px";
}
function bumpDoc() {
  // dirty document-level layout
  document.body.style.paddingTop = (bumpN++ % 50) + "px";
}

export async function run() {
  // ---- DOM setup (not measured for the entries; one-time geometry) ----
  const host = document.createElement("div");
  host.id = "host";
  host.innerHTML =
    '<div id="box" style="width:120px;height:60px;border:3px solid #000;' +
    'overflow:scroll;position:relative">' +
    '<div style="width:600px;height:600px"></div>' +
    "</div>" +
    '<input id="inp" value="hello world text inside the input field" />' +
    '<p id="para">Some paragraph text that the range will select across.</p>' +
    '<svg width="300" height="60"><text id="svgtext" x="0" y="40">' +
    "Measure my SVG text length</text></svg>" +
    '<div style="height:3000px">tall spacer to create scroll</div>';
  document.body.appendChild(host);

  const box = document.getElementById("box");
  const inp = document.getElementById("inp");
  const para = document.getElementById("para");
  const svgtext = document.getElementById("svgtext");

  // settle initial layout once
  sink = box.offsetWidth;

  // ===================== ENTRIES (each: invalidate, then read) =====================

  // --- offsetTop ---
  bump(box);
  sink = box.offsetTop; // E:offsetTop

  // --- offsetWidth ---
  bump(box);
  sink = box.offsetWidth; // E:offsetWidth

  // --- offsetParent ---
  bump(box);
  sink = box.offsetParent; // E:offsetParent

  // --- clientTop ---
  bump(box);
  sink = box.clientTop; // E:clientTop

  // --- clientHeight ---
  bump(box);
  sink = box.clientHeight; // E:clientHeight

  // --- getClientRects() ---
  bump(box);
  sink = box.getClientRects(); // E:getClientRects

  // --- getBoundingClientRect() ---
  bump(box);
  sink = box.getBoundingClientRect(); // E:getBoundingClientRect

  // --- scrollTop (read) ---
  bump(box);
  sink = box.scrollTop; // E:scrollTop

  // --- scrollWidth ---
  bump(box);
  sink = box.scrollWidth; // E:scrollWidth

  // --- scrollHeight ---
  bump(box);
  sink = box.scrollHeight; // E:scrollHeight

  // --- innerText (read) ---
  bump(para);
  sink = para.innerText; // E:innerText

  // --- getComputedStyle().height (layout-dependent computed value) ---
  bump(box);
  sink = window.getComputedStyle(box).height; // E:getComputedStyle

  // --- window.innerHeight ---
  bumpDoc();
  sink = window.innerHeight; // E:innerHeight

  // --- window.scrollY ---
  bumpDoc();
  sink = window.scrollY; // E:scrollY

  // --- document.elementFromPoint() ---
  bumpDoc();
  sink = document.elementFromPoint(10, 10); // E:elementFromPoint

  // --- range.getBoundingClientRect() ---
  bump(para);
  {
    const r = document.createRange();
    r.selectNodeContents(para);
    sink = r.getBoundingClientRect(); // E:range.getBoundingClientRect
  }

  // --- SVG getComputedTextLength() ---
  bump(box);
  sink = svgtext.getComputedTextLength(); // E:getComputedTextLength

  // --- input.focus() ---
  bump(box);
  inp.focus(); // E:focus

  // --- input.select() ---
  bump(box);
  inp.select(); // E:select

  // --- scrollIntoView() ---
  bump(box);
  box.scrollIntoView(); // E:scrollIntoView

  // --- window.scrollTo() ---
  bumpDoc();
  window.scrollTo(0, 5); // E:scrollTo

  // --- window.scrollBy() ---
  bumpDoc();
  window.scrollBy(0, 1); // E:scrollBy

  // --- CONTROL: read a non-geometric property after invalidation ---
  bump(box);
  sink = box.tagName; // E:CONTROL_tagName

  return { ok: true, sink: String(sink).slice(0, 10) };
}
