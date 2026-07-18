import { test } from "node:test";
import assert from "node:assert/strict";
import { blameSemanticFor, noteCountScope, positionMissNote } from "../../dist/commands/record.js";
import { capsFor } from "../../dist/browser/backend.js";
import { firefoxForcedCountSemantics } from "../../dist/record/notes.js";

// DELETED WITH the two-pass machinery: these pin blameSemanticFor / noteCountScope, which live in
// src/record/passplan.ts (the counts-vs-wall pass plan) and go away with the planned span rewrite.

test("blameSemanticFor: names the engine's question, and stays absent when there is no blame", () => {
  const timing = { name: "timing", categories: null, cpu: true };
  const trace = { name: "trace", categories: ["devtools.timeline"] };
  const gecko = { name: "gecko", categories: null, gecko: true };

  assert.equal(blameSemanticFor([timing, trace]), "flush-site", "chrome blames the read");
  // The gecko pass now surfaces read-site (flush-site) blame from the sampled DOM-accessor stacks,
  // so it names the same question as Chrome (the write-cause markers stay reachable, but are not
  // the blame answer).
  assert.equal(blameSemanticFor([timing, gecko]), "flush-site", "gecko blames the read too");
  // The branch worth pinning: a plan with neither pass produces no blame at all, so claiming a
  // semantic would describe lines that do not exist. --no-trace and --target node land here.
  assert.equal(blameSemanticFor([timing]), undefined, "--no-trace produces no blame");
  assert.equal(blameSemanticFor([]), undefined, "no passes, no blame");
});

test("noteCountScope: describes the pass plan that ran, per lane", () => {
  const timing = { name: "timing", categories: null, cpu: true, bracketFirstIteration: true };
  const tracePinned = { name: "trace", categories: ["devtools.timeline"], iterations: 1 };
  const traceAll = { name: "trace", categories: ["devtools.timeline"] };
  const gecko = { name: "gecko", categories: null, gecko: true };
  const breakdownPass = {
    name: "breakdown",
    categories: ["devtools.timeline"],
    cpu: true,
    keepThreadIds: true,
  };
  const bench = (iterations) => ({ driver: false, iterations });
  // Real caps, not hand-rolled objects: the note must stay tied to what the backend can do.
  const chrome = capsFor("chrome");
  const firefoxCaps = capsFor("firefox");

  // Nothing to say at one iteration: there is nothing to scale.
  assert.equal(noteCountScope([timing, tracePinned], bench(1), chrome), null);
  assert.equal(noteCountScope([timing, tracePinned], { driver: true, iterations: 1 }, chrome), null);

  // --iterations repeats run() in BOTH modes, so the scope question is real in both. Driver used
  // to be exempted here, which left `record --iterations 4 --no-isolate` reporting overall counts
  // totalled across 4 with nothing saying so (measured: layoutCount 28 vs 7 per iteration).
  const driverTotals = noteCountScope([traceAll], { driver: true, iterations: 4 }, chrome);
  assert.match(driverTotals, /TOTALS across all 4/);
  assert.match(driverTotals, /Per-step counts are unaffected/, "per-step counts are still per-iteration");

  const isolated = noteCountScope([timing, tracePinned], bench(20), chrome);
  assert.match(isolated, /FIRST timed iteration/, "default lane scopes counts to one iteration");
  assert.match(isolated, /trace pass runs a single iteration/);

  // --no-trace: no trace pass exists, so the note must not claim one runs a single iteration.
  const noTrace = noteCountScope([timing], bench(20), chrome);
  assert.match(noTrace, /FIRST timed iteration/);
  assert.doesNotMatch(noTrace, /trace pass/, "must not describe a pass that never ran");

  // --no-isolate: the only pass carries wall AND counts, so counts really are totals. Claiming
  // per-iteration here would be the mixed-window bug (layout from 1 iteration, forced from N).
  const noIsolate = noteCountScope([traceAll], bench(20), chrome);
  assert.match(noIsolate, /TOTALS across all 20/);
  assert.match(noIsolate, /--no-isolate/);

  // --breakdown: one fused pass (light trace + sampler) carries wall AND counts, so it runs every
  // iteration and its counts total. noteCountScope must disclose this, not return null.
  const breakdown = noteCountScope([breakdownPass], bench(3), chrome);
  assert.ok(breakdown, "the breakdown lane discloses its count scope");
  assert.match(breakdown, /TOTALS across all 3/);
  assert.match(breakdown, /--breakdown fuses/);

  // Firefox: the gecko pass is the lane's CPU sampler, so it runs every iteration and totals.
  const firefox = noteCountScope([timing, gecko], bench(20), firefoxCaps);
  assert.match(firefox, /TOTALS across all 20/);
  assert.match(firefox, /CPU sampler/);

  // Firefox with no gecko pass (programmatic cpuProfile:false; the CLI refuses it). timingSpec
  // still carries bracketFirstIteration, but runPass only splits when the backend HAS CDP
  // counters, so promising a CDP bracket here would describe a split that never ran -- next to a
  // sibling note saying every count on this lane is 0.
  assert.equal(
    noteCountScope([timing], bench(20), firefoxCaps),
    null,
    "no CDP counters means no bracket to describe",
  );
});

test("positionMissNote: names each position-missed script and its miss count, else null", () => {
  // Nothing to say when no map position-missed: the field is absent on a clean run.
  assert.equal(positionMissNote({ scripts: 3, resolved: 3 }), null);
  assert.equal(positionMissNote({ scripts: 3, resolved: 3, positionMisses: {} }), null);

  const note = positionMissNote({
    scripts: 2,
    resolved: 2,
    positionMisses: { "http://host/entry.js": { misses: 4, hits: 12 } },
  });
  assert.match(note, /1 script\(s\)/);
  assert.match(note, /http:\/\/host\/entry\.js/, "names the offending script");
  assert.match(note, /4 of 16 frame lookups unmapped/, "states the honest miss count, no ms");
  assert.match(note, /bucketed by origin/);
  assert.match(note, /meta\.sourcemaps\.positionMisses/);
  // Disclosure only: no fabricated milliseconds attached to the missed positions.
  assert.doesNotMatch(note, /\bms\b/);
});

test("firefoxForcedCountSemantics: discloses the write-site cause-stack origin, warns off cross-engine compare", () => {
  const note = firefoxForcedCountSemantics();
  assert.match(note, /cause stack/i, "names the marker cause-stack source");
  assert.match(note, /read-site/, "contrasts with Chrome's read-site rule");
  assert.match(note, /compare forced counts across engines/i, "warns off cross-engine comparison");
});
