// The addon registry: the ONE wiring point the core imports to reach the framework addons. The core
// calls addons only through `activeAddons()` + the `Addon` interface (model/addon.ts); it imports no
// addon internals. This list is the sole coupling -- clearing it (or `--framework off`) makes no addon
// code run and every recording byte-identical to one wpd wrote before addons existed.

import type { Addon, FrameworkMode } from "../model/addon.js";
import { reactAddon } from "./react/index.js";
import { reactDevAddon } from "./react-dev/index.js";

// Order matters: `react` runs first so its detected build is on the run span before `react-dev` reads
// it to decide whether to classify the dev-only track stream.
const REGISTERED_ADDONS: readonly Addon[] = [reactAddon, reactDevAddon];

/** The addons active for a run. `off` runs none (the guarantee `--framework off` makes); `auto` offers
 * every registered addon, each of which no-ops where its factual signals are absent. */
export function activeAddons(mode: FrameworkMode): Addon[] {
  if (mode === "off") return [];
  return [...REGISTERED_ADDONS];
}
