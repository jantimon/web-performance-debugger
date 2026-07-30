// Node-lane fixture for the react-addon e2e: run() drives the fake react-dom server anchors so a
// `--target node` recording resolves react-dom frames named like the server-phase anchors, exercising
// the `react` addon's phase rollup end-to-end from a clean checkout with no install

import { renderWithHooks, renderElement, pushStartInstance } from "./react-dom-lib/server.mjs";

export function run() {
  let total = 0;
  total += renderWithHooks();
  total += renderElement();
  total += pushStartInstance();
  return total;
}
