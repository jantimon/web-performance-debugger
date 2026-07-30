import { test } from "node:test";
import assert from "node:assert/strict";
import { activeAddons } from "../../dist/addons/registry.js";
import { addonPageInits, runEnrich } from "../../dist/model/addon.js";
import { reactAddon } from "../../dist/addons/react/index.js";
import { reactDevAddon } from "../../dist/addons/react-dev/index.js";
import { reactServerPhaseRollup } from "../../dist/addons/react/phases.js";
import { isReactHydrationError } from "../../dist/addons/react/hydration.js";
import { classifyReactTracks } from "../../dist/addons/react-dev/classify.js";


const runSpan = () => ({ label: "run", kind: "run", aggregation: "sum", wallMs: 10, counts: {} });
const stepSpan = (label) => ({ label, kind: "step", aggregation: "first", wallMs: 5, counts: {} });
const cpuFn = (fn, pkg, selfMs, file) => ({
  id: 0,
  fn,
  package: pkg,
  selfMs,
  selfPct: 0,
  totalMs: selfMs,
  ...(file ? { file } : {}),
});
// A React TimeStamp trace event as parseTrace stores it (kind "other", args.data.track intact). React
// emits it as an INSTANT marker (ph "I", dur 0); the phase span is on args.data.start/end (the extended
// console.timeStamp(label, start, end, ...) arguments), same trace clock (us). `spanUs` is end - start
const timeStamp = (track, trackGroup, start, spanUs) => ({
  id: 0,
  name: "TimeStamp",
  ts: start + spanUs,
  dur: 0,
  ph: "I",
  kind: "other",
  args: { data: { track, trackGroup, start, end: start + spanUs } },
});


test("registry: off runs no addons, auto offers react + react-dev in order", () => {
  assert.deepEqual(activeAddons("off"), []);
  const auto = activeAddons("auto");
  assert.deepEqual(
    auto.map((addon) => addon.name),
    ["react", "react-dev"],
  );
});

test("off = zero addon code: activeAddons('off') feeds runEnrich nothing, so no enrich runs", () => {
  let calls = 0;
  const spy = { name: "spy", enrich: () => void calls++ };
  const context = {
    meta: {},
    spans: [runSpan()],
    spanWindows: [],
    pageData: undefined,
    stepData: new Map(),
    cpuModel: undefined,
    events: [],
  };
  // The guarantee: off resolves to [], and runEnrich over [] calls no addon
  runEnrich(activeAddons("off"), context);
  assert.equal(calls, 0);
  // A spy proves the harness would have counted a call had one been offered
  runEnrich([spy], context);
  assert.equal(calls, 1);
});

test("only the react addon declares a page probe; react-dev reads the stored log", () => {
  // The React detection hook is the sole page install; react-dev has no page probe
  assert.equal(addonPageInits([reactAddon]).length, 1);
  assert.equal(addonPageInits([reactDevAddon]).length, 0);
  assert.equal(typeof reactAddon.pageInit().install, "function");
  assert.equal(reactDevAddon.pageInit, undefined);
});


test("react enrich: run-level detection payload shapes onto the run span", () => {
  const spans = [runSpan()];
  reactAddon.enrich({
    meta: {},
    spans,
    spanWindows: [],
    pageData: {
      react: {
        detected: true,
        version: "19.2.0",
        rendererPackageName: "react-dom",
        build: "development",
        commitCount: 5,
      },
    },
    stepData: new Map(),
    cpuModel: undefined,
    events: [],
  });
  assert.deepEqual(spans[0].addons.react, {
    detected: true,
    version: "19.2.0",
    rendererPackageName: "react-dom",
    build: "development",
    commitCount: 5,
  });
});

test("react enrich: per-step commit count lands on the matching step span", () => {
  const spans = [runSpan(), stepSpan("increment")];
  reactAddon.enrich({
    meta: {},
    spans,
    spanWindows: [],
    pageData: { react: { detected: true, build: "production" } },
    stepData: new Map([["increment", { react: { commits: 2 } }]]),
    cpuModel: undefined,
    events: [],
  });
  assert.equal(spans[1].addons.react.commitCount, 2);
  // Production build is carried honestly, no fabricated dev fields
  assert.equal(spans[0].addons.react.build, "production");
});


// The pure classifier: matches React's hydration recoverable errors (either build) via the react.dev
// marker, and nothing else. [measured] react 19.2 fires #418 in production and the hydration-mismatch
// link in development
test("isReactHydrationError: matches production code and dev link, rejects other errors", () => {
  // production minified form (measured)
  assert.equal(
    isReactHydrationError("Minified React error #418; visit https://react.dev/errors/418?args[]=text"),
    true,
  );
  // development full text (measured)
  assert.equal(
    isReactHydrationError("Hydration failed because the server rendered text didn't match the client. https://react.dev/link/hydration-mismatch"),
    true,
  );
  assert.equal(isReactHydrationError("Minified React error #425; visit https://react.dev/errors/425"), true);
  // a NON-hydration React error must not count
  assert.equal(isReactHydrationError("Minified React error #300; visit https://react.dev/errors/300"), false);
  // an arbitrary app error is never React's
  assert.equal(isReactHydrationError("TypeError: Cannot read properties of undefined"), false);
  assert.equal(isReactHydrationError(""), false);
});

test("react enrich: a hydration recoverable error surfaces as a run-span fact, non-hydration errors do not", () => {
  const spans = [runSpan()];
  reactAddon.enrich({
    meta: {},
    spans,
    spanWindows: [],
    pageData: {
      react: {
        detected: true,
        build: "production",
        hydrationErrorMessages: [
          "Minified React error #300; visit https://react.dev/errors/300", // not hydration: ignored
          "Minified React error #418; visit https://react.dev/errors/418?args[]=text", // hydration
        ],
      },
    },
    stepData: new Map(),
    cpuModel: undefined,
    events: [],
  });
  assert.equal(spans[0].addons.react.hydrationRecoverableErrors, 1, "only the #418 hydration error counts");
  assert.match(spans[0].addons.react.firstHydrationError, /#418/);
});

test("react enrich: no hydration fact when none was observed (absent, never a fabricated 0)", () => {
  const spans = [runSpan()];
  reactAddon.enrich({
    meta: {},
    spans,
    spanWindows: [],
    pageData: { react: { detected: true, build: "production", hydrationErrorMessages: [] } },
    stepData: new Map(),
    cpuModel: undefined,
    events: [],
  });
  assert.ok(!("hydrationRecoverableErrors" in spans[0].addons.react), "absent, not 0 (absence is not proof of clean hydration)");
});

test("react enrich: detected:false attaches no React vocabulary, and no phases off a browser lane", () => {
  // The hook seeds detected:false + a commits:0 step channel on every page; a non-React app must come
  // back with NO react slot. And a browser (driver) lane must never roll react-dom-named frames up as
  // "server phases" (that rollup is node-lane only)
  const spans = [runSpan(), stepSpan("click")];
  reactAddon.enrich({
    meta: { workload: { lane: "driver" } },
    spans,
    spanWindows: [],
    pageData: { react: { detected: false } },
    stepData: new Map([["click", { react: { commits: 0 } }]]),
    cpuModel: { functions: [cpuFn("renderWithHooks", "react-dom", 6)] },
    events: [],
  });
  assert.equal(spans[0].addons, undefined);
  assert.equal(spans[1].addons, undefined);
});


test("reactServerPhaseRollup: pools react-dom self-time onto the stable anchors, descending", () => {
  const model = {
    functions: [
      cpuFn("renderWithHooks", "react-dom", 6),
      cpuFn("renderElement", "react-dom", 3),
      cpuFn("pushStartInstance", "react-dom", 1.5),
      cpuFn("get", "tailwind-merge", 4), // not an anchor
      cpuFn("renderElement", "app", 9), // right name, wrong package
    ],
  };
  const rollup = reactServerPhaseRollup(model);
  assert.equal(rollup.totalMs, 10.5);
  assert.deepEqual(
    rollup.anchors.map((anchor) => anchor.name),
    ["renderWithHooks", "renderElement", "pushStartInstance"],
  );
  assert.equal(rollup.anchors[0].selfMs, 6);
});

test("reactServerPhaseRollup: absent when no anchor resolved (React 18 prod is mangled)", () => {
  // Mangled server build: one-letter names, none in the allowlist -> honestly absent, never 0
  const mangled = { functions: [cpuFn("Fb", "react-dom", 8), cpuFn("Ib", "react-dom", 5)] };
  assert.equal(reactServerPhaseRollup(mangled), undefined);
});

test("react enrich: node lane attaches phases and notes react-dom-without-anchors honestly", () => {
  const nodeMeta = { workload: { lane: "node" } };
  const withAnchors = [runSpan()];
  const notes = reactAddon.enrich({
    meta: nodeMeta,
    spans: withAnchors,
    spanWindows: [],
    pageData: undefined,
    stepData: new Map(),
    cpuModel: { functions: [cpuFn("renderWithHooks", "react-dom", 6)] },
    events: [],
  });
  assert.equal(withAnchors[0].addons.react.phases.totalMs, 6);
  assert.deepEqual(notes, []);

  const mangled = [runSpan()];
  const mangledNotes = reactAddon.enrich({
    meta: nodeMeta,
    spans: mangled,
    spanWindows: [],
    pageData: undefined,
    stepData: new Map(),
    cpuModel: { functions: [cpuFn("Fb", "react-dom", 8)] },
    events: [],
  });
  assert.equal(mangled[0].addons, undefined);
  assert.equal(mangledNotes.length, 1);
  assert.match(mangledNotes[0], /no server-phase anchor resolved/);
});


test("classifyReactTracks: buckets React track events by label, sums duration, ignores non-React", () => {
  const events = [
    timeStamp("Blocking", "Scheduler ⚛", 100, 2000),
    timeStamp("Blocking", "Scheduler ⚛", 200, 3000),
    timeStamp("Components ⚛", "Components ⚛", 300, 1000),
    timeStamp("Timings", "console.timeStamp", 400, 5000), // not React: no atom mark
    { id: 0, name: "Layout", ts: 500, dur: 100, ph: "X", kind: "layout" }, // not a TimeStamp
  ];
  const facts = classifyReactTracks(events);
  assert.equal(facts.total, 3);
  assert.equal(facts.totalMs, 6); // (2000 + 3000 + 1000) us -> 6 ms
  assert.equal(facts.tracks[0].track, "Blocking");
  assert.equal(facts.tracks[0].count, 2);
  assert.equal(facts.tracks[0].group, "Scheduler ⚛");
  assert.equal(facts.tracks[1].track, "Components ⚛");
});

// The phase span lives on args.data.start/end, not event.dur (the event is an instant marker). A lane
// React only declared (start == end) is a genuine 0, kept as a count with no ms
test("classifyReactTracks: duration comes from data.start/end, not the instant event's dur", () => {
  const events = [
    // Real span (Render phase): start 1000, end 6300 -> 5300us -> 5.3ms. dur:0 on the event
    { id: 0, name: "TimeStamp", ts: 6300, dur: 0, ph: "I", kind: "other", args: { data: { track: "Blocking", trackGroup: "Scheduler ⚛", start: 1000, end: 6300 } } },
    // Lane declaration: start == end -> 0 ms, but still a counted entry
    { id: 1, name: "TimeStamp", ts: 200, dur: 0, ph: "I", kind: "other", args: { data: { track: "Idle", trackGroup: "Scheduler ⚛", start: 200, end: 200 } } },
    // A stray dur on the event must NOT be read (no start/end -> 0 ms)
    { id: 2, name: "TimeStamp", ts: 300, dur: 9999, ph: "I", kind: "other", args: { data: { track: "Suspense", trackGroup: "Scheduler ⚛" } } },
  ];
  const facts = classifyReactTracks(events);
  assert.equal(facts.total, 3);
  const blocking = facts.tracks.find((bucket) => bucket.track === "Blocking");
  assert.equal(blocking.ms, 5.3, "the Render span from start/end");
  const idle = facts.tracks.find((bucket) => bucket.track === "Idle");
  assert.equal(idle.ms, 0, "a lane declaration (start == end) is a counted 0, not a fabricated span");
  const suspense = facts.tracks.find((bucket) => bucket.track === "Suspense");
  assert.equal(suspense.ms, 0, "the event's own dur is never read");
});

test("classifyReactTracks: null when no React track event is present (never a fabricated zero)", () => {
  assert.equal(classifyReactTracks([]), null);
  assert.equal(classifyReactTracks([timeStamp("Timings", "console.timeStamp", 1, 10)]), null);
});


test("react-dev enrich: no-op unless react detected a development build", () => {
  const events = [timeStamp("Blocking", "Scheduler ⚛", 100, 2000)];
  const spanWindows = [{ label: "run", kind: "run", startTs: null, endTs: null }];

  // Production build: gate closed, no react-dev facts even though track events exist
  const prod = [{ ...runSpan(), addons: { react: { build: "production" } } }];
  reactDevAddon.enrich({ meta: {}, spans: prod, spanWindows, pageData: undefined, stepData: new Map(), cpuModel: undefined, events });
  assert.equal(prod[0].addons["react-dev"], undefined);

  // Development build + entries present: gate open, facts attached to the run span
  const dev = [{ ...runSpan(), addons: { react: { build: "development" } } }];
  reactDevAddon.enrich({ meta: {}, spans: dev, spanWindows, pageData: undefined, stepData: new Map(), cpuModel: undefined, events });
  assert.equal(dev[0].addons["react-dev"].total, 1);
});

test("react-dev enrich: no-op when the event log is empty (--deep required)", () => {
  const dev = [{ ...runSpan(), addons: { react: { build: "development" } } }];
  reactDevAddon.enrich({
    meta: {},
    spans: dev,
    spanWindows: [{ label: "run", kind: "run", startTs: null, endTs: null }],
    pageData: undefined,
    stepData: new Map(),
    cpuModel: undefined,
    events: [],
  });
  assert.equal(dev[0].addons["react-dev"], undefined);
});
