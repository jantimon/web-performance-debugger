import { test } from "node:test";
import assert from "node:assert/strict";
import {
  captureFor,
  capabilitiesFor,
  capabilitiesAfterParse,
  blameSemanticFor,
  countScopeNote,
} from "../../dist/record/capture.js";
import * as notes from "../../dist/record/notes.js";

// The one-pass capture modes: which capture config each flag combination yields. Every capture mode is
// exactly one pass (one categories set, one cpu decision), so the whole capture story is this pure function.
const opts = (over = {}) => ({ iterations: 1, driver: false, cpuProfile: true, ...over });

test("captureFor: chrome default capture mode is the sampler alone, no trace", () => {
  const config = captureFor(opts(), "chrome");
  assert.equal(config.mode, "default");
  assert.equal(config.categories, null, "no trace in the default capture mode");
  assert.equal(config.cpu, true, "the sampler rides the default capture mode");
  assert.equal(config.gecko, false);
});

test("captureFor: --precise-wall is the default capture mode minus the sampler", () => {
  const config = captureFor(opts({ preciseWall: true }), "chrome");
  assert.equal(config.mode, "precise-wall");
  assert.equal(config.categories, null, "no trace");
  assert.equal(config.cpu, false, "the sampler is off for a pristine wall");
});

test("captureFor: --breakdown is the light trace fused with the sampler (no .stack, no invalidationTracking)", () => {
  const config = captureFor(opts({ breakdown: true }), "chrome");
  assert.equal(config.mode, "breakdown");
  assert.ok(Array.isArray(config.categories));
  assert.ok(
    !config.categories.includes("disabled-by-default-devtools.timeline.stack"),
    "the light trace drops .stack (keeps sampled self-time clean and blame out)",
  );
  assert.ok(
    !config.categories.includes("disabled-by-default-devtools.timeline.invalidationTracking"),
    "and invalidationTracking",
  );
  assert.equal(config.cpu, true, "the sampler rides the light trace");
  assert.ok(
    config.categories.includes("disabled-by-default-v8.cpu_profiler"),
    "the light trace carries the v8.cpu_profiler stream (the CPU sample source)",
  );
  assert.equal(config.cpuSource, "trace", "CPU samples come from the trace stream, not the CDP sampler");
  assert.equal(config.keepThreadIds, true, "the bar windows to the main thread");
});

test("captureFor: cpuSource is 'cdp' in every capture mode but --breakdown (only that one runs a trace profiler)", () => {
  assert.equal(captureFor(opts(), "chrome").cpuSource, "cdp", "default capture mode uses the CDP sampler");
  assert.equal(captureFor(opts({ deep: true }), "chrome").cpuSource, "cdp");
  assert.equal(captureFor(opts({ preciseWall: true }), "chrome").cpuSource, "cdp");
  assert.equal(captureFor(opts(), "firefox").cpuSource, "cdp", "firefox samples come from the gecko dump");
  assert.equal(captureFor(opts({ breakdown: true }), "chrome").cpuSource, "trace");
});

test("captureFor: --deep is the full trace with the sampler OFF", () => {
  const config = captureFor(opts({ deep: true }), "chrome");
  assert.equal(config.mode, "deep");
  assert.ok(config.categories.includes("disabled-by-default-devtools.timeline.stack"), "keeps .stack for forced blame");
  assert.ok(config.categories.includes("disabled-by-default-devtools.timeline.invalidationTracking"), "keeps invalidationTracking");
  assert.equal(config.cpu, false, "the sampler must NEVER ride a .stack trace (+21% self-time inflation)");
  assert.equal(config.keepThreadIds, true, "counts window to the main thread");
});

test("captureFor: firefox is always the one gecko pass (the capture modes are reporting tiers over it)", () => {
  const config = captureFor(opts(), "firefox");
  assert.equal(config.mode, "gecko");
  assert.equal(config.gecko, true, "the gecko profiler runs");
  assert.equal(config.categories, null, "no DevTools trace on firefox");
  // A programmatic cpuProfile:false yields a timing-only pass that counts nothing.
  const off = captureFor(opts({ cpuProfile: false }), "firefox");
  assert.equal(off.gecko, false);
});

test("captureFor: firefox --deep is the SAME gecko capture, only the capture-mode name records the report tier", () => {
  const deep = captureFor(opts({ deep: true }), "firefox");
  assert.equal(deep.mode, "gecko-deep", "the --deep reporting tier is named in the capture-mode name");
  assert.equal(deep.gecko, true, "the gecko profiler still runs (capture is unchanged)");
  assert.equal(deep.categories, null, "still no DevTools trace: --deep adds no .stack on firefox");
  // The capture is byte-identical to the default gecko pass apart from the capture-mode label, so what the
  // pass can observe (capabilities) and what blame names are unchanged.
  const dflt = captureFor(opts(), "firefox");
  assert.deepEqual(
    capabilitiesFor(deep, "firefox"),
    capabilitiesFor(dflt, "firefox"),
    "firefox --deep observes exactly what the default gecko pass does",
  );
  assert.equal(blameSemanticFor(deep), "flush-site", "blame still names the read site, not the write");
});

// capabilitiesFor gates each count/duration to Measured. The HARD GUARD: durations are refusable on
// a .stack trace (--deep counts yes, durations no), and the default capture mode measures nothing.
test("capabilitiesFor: default capture mode measures nothing; --breakdown counts+durations; --deep counts, no durations", () => {
  const dflt = capabilitiesFor(captureFor(opts(), "chrome"), "chrome");
  assert.deepEqual(dflt, {
    counts: false,
    paintCount: false,
    longTasks: false,
    invalidations: false,
    durations: false,
    forced: false,
  });

  const light = capabilitiesFor(captureFor(opts({ breakdown: true }), "chrome"), "chrome");
  assert.equal(light.counts, true);
  assert.equal(light.durations, true, "light trace: durations trustworthy");
  assert.equal(light.forced, false, "no .stack, so no forced detection");
  assert.equal(light.invalidations, false, "invalidationTracking dropped");

  const deep = capabilitiesFor(captureFor(opts({ deep: true }), "chrome"), "chrome");
  assert.equal(deep.counts, true, "counts exact on the .stack trace");
  assert.equal(deep.durations, false, "durations REFUSED on the .stack trace (it inflates them)");
  assert.equal(deep.forced, true, ".stack drives forced detection");
  assert.equal(deep.invalidations, true, "invalidationTracking present");
});

test("capabilitiesFor: firefox counts layout/style/forced from markers, never paint/invalidations/long-tasks", () => {
  const caps = capabilitiesFor(captureFor(opts(), "firefox"), "firefox");
  assert.equal(caps.counts, true);
  assert.equal(caps.forced, true);
  assert.equal(caps.paintCount, false, "paint is off-main-thread on Gecko");
  assert.equal(caps.invalidations, false);
  assert.equal(caps.longTasks, false);
});

test("blameSemanticFor: --deep and firefox name the read (flush-site); the default capture mode has no blame", () => {
  assert.equal(blameSemanticFor(captureFor(opts({ deep: true }), "chrome")), "flush-site");
  assert.equal(blameSemanticFor(captureFor(opts(), "firefox")), "flush-site");
  assert.equal(blameSemanticFor(captureFor(opts(), "chrome")), undefined, "default capture mode: no trace, no blame");
  assert.equal(blameSemanticFor(captureFor(opts({ breakdown: true }), "chrome")), undefined, "light trace has no .stack, so no blame");
});

test("countScopeNote: null at one iteration or with no counts; a TOTAL disclosure otherwise", () => {
  const light = capabilitiesFor(captureFor(opts({ breakdown: true }), "chrome"), "chrome");
  assert.equal(countScopeNote(light, opts({ breakdown: true, iterations: 1 })), null, "nothing to scale at 1");
  const dflt = capabilitiesFor(captureFor(opts(), "chrome"), "chrome");
  assert.equal(countScopeNote(dflt, opts({ iterations: 8 })), null, "the default capture mode counts nothing to scope");

  const note = countScopeNote(light, opts({ breakdown: true, iterations: 8 }));
  assert.match(note, /TOTALS across all 8/);
  assert.match(note, /one pass/);
  // Driver per-step counts window to iteration 0, so the note says they are unaffected.
  const driverNote = countScopeNote(light, opts({ breakdown: true, iterations: 8, driver: true }));
  assert.match(driverNote, /Per-step counts are unaffected/);
});

test("capabilitiesAfterParse: a lost run window degrades every rendering capability to not-measured", () => {
  const deep = capabilitiesFor(captureFor({ deep: true }), "chrome");
  assert.equal(deep.counts, true, "precondition: --deep observes counts");
  const degraded = capabilitiesAfterParse(deep, false);
  for (const [capability, enabled] of Object.entries(degraded))
    assert.equal(enabled, false, `${capability} must be not-measured when the window is lost`);
  assert.deepEqual(capabilitiesAfterParse(deep, true), deep, "a found window changes nothing");
});

// Drift guard: the not-measured NOTES must agree with capabilitiesFor and honor the Measured
// contract. Under that contract unmeasured is `—`/null and 0 is measured-clean, so a note that tells
// a reader "a 0 there means unmeasured" contradicts the model that already renders unmeasured as `—`.
test("notes: the breakdown invalidation note matches capabilitiesFor and never equates 0 with unmeasured", () => {
  const caps = capabilitiesFor(captureFor(opts({ breakdown: true }), "chrome"), "chrome");
  assert.equal(caps.invalidations, false, "precondition: --breakdown drops invalidationTracking");
  const note = notes.breakdownInvalidationNotMeasured();
  assert.match(note, /NOT measured/, "the note states the count is not measured");
  assert.match(note, /never 0/, "and that it reports as not-measured, not a 0");
  assert.doesNotMatch(note, /means unmeasured/i, "unmeasured is —, never a 0 that 'means unmeasured'");
});

test("notes: the firefox counts note matches capabilitiesFor (paint not measured; layout/style/forced measured)", () => {
  const caps = capabilitiesFor(captureFor(opts(), "firefox"), "firefox");
  assert.equal(caps.paintCount, false);
  assert.equal(caps.counts, true);
  assert.equal(caps.forced, true);
  const note = notes.firefoxRenderingCountsMeasured();
  assert.match(note, /layoutCount\/styleCount\/forcedLayoutCount ARE measured/);
  assert.match(note, /never a fake 0/);
  assert.match(note, /paintCount/, "and names paint as the not-measured one");
});

test("notes: no note equates a literal 0 with unmeasured (unmeasured renders — under the Measured contract)", () => {
  const strings = Object.values(notes)
    .filter((value) => typeof value === "function")
    .map((make) => {
      try {
        return make(2, 12, 3, "http://example.test", "trace");
      } catch {
        return "";
      }
    });
  assert.ok(strings.length > 10, "sanity: found the note catalog");
  for (const note of strings) {
    assert.doesNotMatch(note, /a 0\b[^.]*means unmeasured/i, `note wrongly equates 0 with unmeasured: ${note}`);
    assert.doesNotMatch(note, /literal `?0`?[^.]*unmeasured/i, `note claims a literal 0 for unmeasured: ${note}`);
  }
});
