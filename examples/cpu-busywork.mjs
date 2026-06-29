// CPU sampling smoke test (in-page): a few named functions doing measurable JS work,
// so the profile has clear hot frames to attribute back to these exact source lines.
// Run: node dist/cli.js record examples/cpu-busywork.mjs --bench --cpu-profile --iterations 50
//      node dist/cli.js query cpu latest

function hashString(input) {
  let hash = 0;
  for (let index = 0; index < input.length; index++) {
    hash = (hash * 31 + input.charCodeAt(index)) | 0;
  }
  return hash;
}

function serializeStyle(seed) {
  let css = "";
  for (let index = 0; index < 40; index++) {
    css += `.cell-${seed}-${index}{width:${(seed * index) % 100}px;color:hsl(${index},50%,50%)}`;
  }
  return css;
}

function buildRows(count) {
  let total = 0;
  for (let index = 0; index < count; index++) {
    total += hashString(serializeStyle(index));
  }
  return total;
}

export function run() {
  let sink = 0;
  for (let round = 0; round < 50; round++) sink += buildRows(200);
  return sink;
}
