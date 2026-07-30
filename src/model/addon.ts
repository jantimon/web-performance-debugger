// The framework-addon seam. React support is an OPTIONAL ADDON, never core: profiling React must feel
// optional, and wpd must not become a React profiling tool. Every addon lives under src/addons/ behind
// this ONE narrow interface the core calls; the core never imports an addon's internals, only the
// registry (src/addons/registry.ts). An addon READS what the capture already recorded and enriches
// spans; it never changes what is captured. With `--framework off` (or an empty registry) no addon
// code runs and no addon facts enter the recording: the `Span.addons` slot stays absent on every span.
// (`meta.framework` records the resolved mode either way -- core provenance, not addon output.)

import type { ReactFacts } from "../addons/react/facts.js";
import type { ReactDevFacts } from "../addons/react-dev/facts.js";
import type { CpuModel } from "./cpu.js";
import type { NormalizedEvent } from "./events.js";
import type { RecordingMeta } from "./meta.js";
import type { Span, SpanKind } from "./recording.js";

/**
 * `--framework`: `off` guarantees zero addon code runs (the registry returns none); `auto` lets each
 * addon's factual detection decide whether it contributes. Default `auto`. Every lane accepts the
 * flag; an addon no-ops where its signals are absent, so `auto` is never a hard failure.
 */
export type FrameworkMode = "off" | "auto";

/**
 * Per-span addon facts. Each key is an addon's `name`. This is the ONLY place the core Span type
 * mentions React vocabulary, and it does so through addon-exported types imported `import type` (erased
 * at runtime), so a consumer who never enables the addon sees no React vocabulary and clearing the
 * registry leaves the compiled core byte-identical. See docs/dev/react-attribution.md.
 */
export interface SpanAddons {
  react?: ReactFacts;
  "react-dev"?: ReactDevFacts;
}

/**
 * The in-page probe a browser-lane addon installs BEFORE app code runs. `install` is serialized into
 * the page (`evaluateOnNewDocument`, so it re-arms on every wpd-owned navigation, plus once on the
 * current document); it must be self-contained (reference no closure variables) and only touch
 * `window`. Convention: an addon stashes its run-level payload on `window.__wpdAddons[<name>]` and, for
 * a per-step read, wraps `window.__wpdAddonStepReset`/`window.__wpdAddonStepRead` (driver mode resets
 * at each step start and reads at each step's flush). Absent on an addon with no page probe.
 */
export interface AddonPageInit {
  install: () => void;
}

/** A span's trace-clock window, so a per-span addon can scope the stored event log to it. */
export interface AddonSpanWindow {
  label: string;
  kind: SpanKind;
  startTs: number | null;
  endTs: number | null;
}

/** Everything an addon needs to derive its facts post-capture, all read-only inputs. The addon mutates
 * `spans[i].addons[<name>]` in place; it never changes counts, bars, or anything the capture measured. */
export interface AddonEnrichContext {
  meta: RecordingMeta;
  /** the built spans (run + steps + measures); the addon attaches facts onto their `addons` slot */
  spans: Span[];
  /** trace-clock windows for the spans, for scoping the event log per span */
  spanWindows: AddonSpanWindow[];
  /** the run-level in-page probe payload, keyed by addon name; undefined on a lane with no page (node) */
  pageData: Record<string, unknown> | undefined;
  /** per-step in-page probe payloads keyed by step label (iteration 0), each keyed by addon name */
  stepData: Map<string, Record<string, unknown>>;
  /** the resolved CPU model, when the capture built one (absent on --deep and browser-timing-only) */
  cpuModel: CpuModel | undefined;
  /** the stored trace event log (chrome --deep / firefox); empty otherwise */
  events: NormalizedEvent[];
}

/**
 * A framework addon. The core calls ONLY these members; it imports no addon internals. Keep the
 * surface minimal -- shaped from what the two shipped addons actually need, nothing speculative.
 */
export interface Addon {
  /** stable key, also the `Span.addons` slot key and the `window.__wpdAddons` payload key */
  readonly name: string;
  /** browser lanes: the in-page probe installed before app code; absent on an addon with no page probe */
  pageInit?(): AddonPageInit | undefined;
  /**
   * Derive this addon's facts and attach them onto the matching spans' `addons` slot, from everything
   * the capture recorded. Pure over the context (it only mutates the `addons` slot). Returns run-level
   * disclosure notes to surface (e.g. why `phases` is absent on React 18 production), or nothing.
   */
  enrich?(context: AddonEnrichContext): string[] | void;
}

/** Collect the in-page install functions of the addons that declare a page probe (browser lanes). */
export function addonPageInits(addons: Addon[]): (() => void)[] {
  const installs: (() => void)[] = [];
  for (const addon of addons) {
    const init = addon.pageInit?.();
    if (init) installs.push(init.install);
  }
  return installs;
}

/** Run each addon's enrichment in order (mutating `context.spans[i].addons`), returning the collected
 * disclosure notes. A no-op when `addons` is empty, so a --framework off run behaves identically. */
export function runEnrich(addons: Addon[], context: AddonEnrichContext): string[] {
  const notes: string[] = [];
  for (const addon of addons) {
    if (!addon.enrich) continue;
    const addonNotes = addon.enrich(context);
    if (addonNotes) notes.push(...addonNotes);
  }
  return notes;
}
