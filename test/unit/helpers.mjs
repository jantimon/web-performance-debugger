// Shared fixture builders and constants for the split unit suites. Each test/unit/*.test.mjs
// imports what it needs from here; the test bodies are unchanged.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

// --- The seven-slice breakdown engine (pure; fixtures, no browser) ---
//
// A nested main-thread flame chart, in microseconds. RunTask contains a FunctionCall (js), which
// contains a Layout; the RunTask also contains a Paint. Disjoint self-time is standard flame-chart
// self-time (children subtracted), so RunTask's own remainder is the `other` bucket.
export const NESTED_EVENTS = [
  { id: 0, name: "RunTask", ts: 0, dur: 100000, ph: "X", kind: "task" },
  { id: 1, name: "FunctionCall", ts: 10000, dur: 30000, ph: "X", kind: "scripting" },
  { id: 2, name: "Layout", ts: 20000, dur: 10000, ph: "X", kind: "layout" },
  { id: 3, name: "Paint", ts: 50000, dur: 10000, ph: "X", kind: "paint" },
];

export const NESTED_WINDOW = { startTs: 0, endTs: 100000 };

// Property test: the reconciliation invariant (Σ slices + idle == wall, no residual) must hold for
// ANY main-thread event set, not just the hand-built fixtures above. A tiny seeded LCG generates
// nested flame charts deterministically (no unseeded Math.random), so a failure is reproducible.
export function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export const BREAKDOWN_KINDS = ["task", "scripting", "layout", "style", "paint", "gc", "composite", "invalidation", "usertiming", "other"];

// A depth-first tree of events whose children lie inside their parent's [start,end]; nesting is what
// exercises the disjoint self-time sweep. Any shape must still tile the window exactly.
export function randomNestedEvents(rand) {
  const events = [];
  let id = 0;
  const windowEnd = 20000 + Math.floor(rand() * 80000);
  const emit = (start, end, depth) => {
    const kind = BREAKDOWN_KINDS[Math.floor(rand() * BREAKDOWN_KINDS.length)];
    events.push({ id: id++, name: kind, ts: start, dur: end - start, ph: "X", kind });
    if (depth <= 0 || end - start < 2000) return;
    let cursor = start + Math.floor(rand() * ((end - start) / 4));
    const childCount = Math.floor(rand() * 3);
    for (let child = 0; child < childCount; child++) {
      const remaining = end - cursor;
      if (remaining < 1000) break;
      const childDur = 500 + Math.floor(rand() * (remaining / 2));
      emit(cursor, cursor + childDur, depth - 1);
      cursor += childDur + Math.floor(rand() * 500);
    }
  };
  const rootCount = 1 + Math.floor(rand() * 3);
  let cursor = 0;
  for (let root = 0; root < rootCount && cursor < windowEnd; root++) {
    const remaining = windowEnd - cursor;
    if (remaining < 1000) break;
    const dur = 1000 + Math.floor(rand() * (remaining - 500));
    emit(cursor, cursor + dur, 3);
    cursor += dur + Math.floor(rand() * 2000);
  }
  return { events, window: { startTs: 0, endTs: windowEnd } };
}

// A synthetic V8 profile: root -> alpha -> beta -> alpha (direct recursion), plus idle and gc.
// node: urls keep frame resolution fully offline (no sourcemap/fs I/O).
export function syntheticProfile() {
  const sys = (functionName) => ({ functionName, scriptId: "0", url: "", lineNumber: -1, columnNumber: -1 });
  const app = (functionName, lineNumber) => ({ functionName, scriptId: "1", url: "node:app", lineNumber, columnNumber: 0 });
  return {
    startTime: 0,
    endTime: 8500,
    nodes: [
      { id: 1, callFrame: sys("(root)"), children: [2, 5, 6] },
      { id: 2, callFrame: app("alpha", 0), children: [3] },
      { id: 3, callFrame: app("beta", 10), children: [4] },
      { id: 4, callFrame: app("alpha", 0), children: [] },
      { id: 5, callFrame: sys("(idle)") },
      { id: 6, callFrame: sys("(garbage collector)") },
    ],
    samples: [4, 3, 2, 5, 6],
    timeDeltas: [1000, 2000, 500, 4000, 1000],
  };
}

// The four-slice CPU breakdown (js/browser/gc/idle) must tile the profile window EXACTLY: every
// sample's delta is attributed to its node, every node classifies into one slice, so the slices
// sum to wall with zero residual. This fixture exercises every synthetic frame plus a node_modules
// split and an app frame, so classification and the js byPackage subdivision are both pinned.
export function breakdownProfile() {
  const sys = (functionName) => ({ functionName, scriptId: "0", url: "", lineNumber: -1, columnNumber: -1 });
  const fileFrame = (functionName, absFile, lineNumber) => ({
    functionName,
    scriptId: "1",
    url: `file://${absFile}`,
    lineNumber,
    columnNumber: 0,
  });
  return {
    startTime: 0,
    endTime: 8000,
    nodes: [
      { id: 1, callFrame: sys("(root)"), children: [2, 3, 4, 5, 6] },
      { id: 2, callFrame: fileFrame("render", "/proj/node_modules/react-dom/index.js", 10), children: [] },
      { id: 3, callFrame: fileFrame("appMain", "/proj/src/app.js", 3), children: [] },
      { id: 4, callFrame: sys("(idle)"), children: [] },
      { id: 5, callFrame: sys("(garbage collector)"), children: [] },
      { id: 6, callFrame: sys("(program)"), children: [] },
    ],
    samples: [2, 3, 4, 5, 6],
    timeDeltas: [1000, 2000, 3000, 1500, 500],
  };
}

// Pseudo-URLs (inline data: modules, blob:, wasm, V8/extension internals) are not on disk.
// They must bucket by scheme, never fs-walk to a stray package.json (which would mis-blame
// them on the tool's own cwd package, as seen profiling blob-iframe SPAs).
export function pseudoUrlProfile() {
  const frame = (functionName, url, lineNumber) => ({
    functionName,
    scriptId: "1",
    url,
    lineNumber,
    columnNumber: 0,
  });
  return {
    startTime: 0,
    endTime: 5000,
    nodes: [
      { id: 1, callFrame: { functionName: "(root)", scriptId: "0", url: "", lineNumber: -1, columnNumber: -1 }, children: [2, 3, 4, 5, 6] },
      // an inline ESM data-URI module (the dashboard's own bundle reports like this)
      { id: 2, callFrame: frame("createElement", "data:text/javascript;base64,dmFyIHg9MTs=", 4), children: [] },
      { id: 3, callFrame: frame("render", "blob:null/2737de37-cf4c-4d3e", 0), children: [] },
      { id: 4, callFrame: frame("compiled", "wasm://wasm/88844f8e:1", 0), children: [] },
      { id: 5, callFrame: frame("SafeBuiltins", "extensions::SafeBuiltins", 7), children: [] },
      { id: 6, callFrame: frame("appfn", "node:app", 0), children: [] },
    ],
    samples: [2, 3, 4, 5, 6],
    timeDeltas: [1000, 1000, 1000, 1000, 1000],
  };
}

// A minified bundle served over http is the case that matters most and was untested: every
// existing test dodges the remote path via node:/pseudo urls or a dead FIXTURE_ORIGIN. These
// serve real bundles and drive the real fetch.
//
// One segment ("AAAAA" = genCol 0 -> source 0, line 0, col 0, name 0) is enough: a CDP frame at
// lineNumber 0 / columnNumber 0 becomes line 1 / column 1, and resolveFrame looks up line 1,
// column 0 -- exactly this segment.
export function sourcemapFor(source, name) {
  return JSON.stringify({
    version: 3,
    file: "bundle.js",
    sources: [source],
    names: [name],
    mappings: "AAAAA",
  });
}

/** Five bundles, each a different sourcemap-acquisition story. */
export async function startBundleServer() {
  const routes = {
    // the map is announced by the conventional trailing comment
    "/comment.js": ["function Bh(){}\n//# sourceMappingURL=comment.js.map", {}],
    "/comment.js.map": [sourcemapFor("node_modules/lodash/lodash.js", "lodashInner"), {}],
    // no comment at all: the map is announced ONLY by the response header, as many
    // production builds do (they strip the comment and keep the header)
    "/header.js": ["function zv(){}", { SourceMap: "/header.js.map" }],
    "/header.js.map": [sourcemapFor("node_modules/react-dom/index.js", "reactRender"), {}],
    // resolves, but to app code outside node_modules
    "/app.js": ["function Wl(){}\n//# sourceMappingURL=app.js.map", {}],
    "/app.js.map": [sourcemapFor("src/App.tsx", "AppRoot"), {}],
    // carries no map reference whatsoever
    "/nomap.js": ["function Qk(){}", {}],
    // names a map that is not deployed (404)
    "/brokenmap.js": ["function Xy(){}\n//# sourceMappingURL=gone.js.map", {}],
  };
  const server = createServer((request, response) => {
    const route = routes[request.url];
    if (!route) {
      response.writeHead(404);
      response.end("not found");
      return;
    }
    const [body, headers] = route;
    response.writeHead(200, { "content-type": "application/javascript", ...headers });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export function remoteBundleProfile(origin) {
  const frame = (functionName, file) => ({
    functionName,
    scriptId: "1",
    url: `${origin}/${file}`,
    lineNumber: 0,
    columnNumber: 0,
  });
  return {
    startTime: 0,
    endTime: 5000,
    nodes: [
      {
        id: 1,
        callFrame: { functionName: "(root)", scriptId: "0", url: "", lineNumber: -1, columnNumber: -1 },
        children: [2, 3, 4, 5, 6],
      },
      { id: 2, callFrame: frame("Bh", "comment.js"), children: [] },
      { id: 3, callFrame: frame("zv", "header.js"), children: [] },
      { id: 4, callFrame: frame("Wl", "app.js"), children: [] },
      { id: 5, callFrame: frame("Qk", "nomap.js"), children: [] },
      { id: 6, callFrame: frame("Xy", "brokenmap.js"), children: [] },
    ],
    samples: [2, 3, 4, 5, 6],
    timeDeltas: [1000, 1000, 1000, 1000, 1000],
  };
}

// --- Step merge (label-keyed; step timings and trace windows come from the same one pass) ---

export const driverStep = (index, label) => ({
  index,
  label,
  wallMs: 10 + index,
  inpMs: null,
});

export const geckoFixture = JSON.parse(
  readFileSync(new URL("../fixtures/gecko-shutdown.trimmed.json", import.meta.url), "utf8"),
);

export const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

// A hand-built Gecko shutdown dump for the js,cpu mechanisms the trimmed real fixture predates: a
// populated `threadCPUDelta` column (idle routing), Layout-category frames (style/layout slices), a
// DOM accessor over a Reflow with a JS ancestor executing line (read-site blame), and a user
// `performance.measure` interval marker (the mark bridge). Kept minimal and readable.
export function syntheticGeckoDump() {
  // Category names must match the ones parseGecko/sampleSlice look up by name.
  const categories = [
    { name: "Idle" },
    { name: "Other" },
    { name: "Layout" }, // 2
    { name: "JavaScript" }, // 3
    { name: "GC / CC" }, // 4
    { name: "DOM" }, // 5
  ];
  const strings = [
    "(root)", // 0
    "run (http://h/app.mjs:10:5)", // 1 JS (cat 3)
    "Reflow http://h/app.mjs", // 2 Layout (cat 2)
    "get HTMLElement.offsetWidth", // 3 DOM accessor (cat 5)
    "hashString (http://h/app.mjs:3:2)", // 4 JS (cat 3)
    "0xdeadbeef", // 5 native leaf, no category
    "Styles", // 6 style marker name
    "UserTiming", // 7 user-timing marker name
    "MinorGC", // 8 (unused name, kept for completeness)
  ];
  // frameTable {location, relevantForJS, innerWindowID, implementation, line, column, category,
  // subcategory}; location holds a stringTable index.
  const frameTable = {
    schema: {
      location: 0,
      relevantForJS: 1,
      innerWindowID: 2,
      implementation: 3,
      line: 4,
      column: 5,
      category: 6,
      subcategory: 7,
    },
    data: [
      [0, false, null, null, null, null, 1, 0], // 0 (root), Other
      [1, false, null, null, 20, 5, 3, 0], // 1 run, JS, executing line 20
      [2, true, null, null, null, null, 2, 0], // 2 Reflow, Layout
      [3, true, null, null, null, null, 5, 0], // 3 get offsetWidth, DOM
      [4, false, null, null, 3, 2, 3, 0], // 4 hashString, JS
      [5, false, null, null, null, null, null, null], // 5 native leaf, no category
    ],
  };
  // stackTable {prefix, frame}
  const stackTable = {
    schema: { prefix: 0, frame: 1 },
    data: [
      [null, 0], // 0 root
      [0, 1], // 1 root->run
      [1, 4], // 2 root->run->hashString  (busywork js sample)
      [1, 3], // 3 root->run->getOffsetWidth
      [3, 2], // 4 ...->getOffsetWidth->Reflow (forced reflow sample, leaf=Reflow)
      [0, 5], // 5 root->native  (idle-ish leaf)
    ],
  };
  // samples {stack, time, threadCPUDelta}; times in ms, cpu in µs.
  const samples = {
    schema: { stack: 0, time: 1, threadCPUDelta: 2 },
    data: [
      [2, 5, 1000], // pre-window (time < run:start 10): dropped
      [2, 11, 1000], // js busywork
      [4, 12, 1000], // forced reflow -> layout slice
      [2, 13, 0], // cpu ~0 -> idle, despite a js stack (idle routing)
      [5, 14, 0], // native idle leaf, cpu 0 -> idle
      [2, 15, 1000], // js busywork
    ],
  };
  const measureData = { name: "paint-phase", entryType: "measure", startMark: null, endMark: null };
  const markCause = { samples: { data: [[1]] } }; // cause stack index 1 = root->run (JS cause)
  // markers {name, startTime, endTime, phase, category, data}
  const markers = {
    schema: { name: 0, startTime: 1, endTime: 2, phase: 3, category: 4, data: 5 },
    data: [
      [7, 10, 10, 0, 5, { name: "wpd:run:start", entryType: "mark" }],
      [7, 16, 16, 0, 5, { name: "wpd:run:end", entryType: "mark" }],
      [7, 11, 13, 1, 5, measureData], // user performance.measure "paint-phase"
      [6, 12, 12.5, 1, 2, { type: "Styles", stack: markCause }], // forced style flush (JS cause)
    ],
  };
  return {
    meta: {
      categories,
      interval: 1,
      sampleUnits: { time: "ms", eventDelay: "ms", threadCPUDelta: "µs" },
    },
    libs: [],
    threads: [
      {
        name: "GeckoMain",
        processType: "tab",
        pid: 1,
        tid: 1,
        stringTable: strings,
        frameTable,
        stackTable,
        samples,
        markers,
      },
    ],
    processes: [],
  };
}

// The fixture's frames carry this served origin (captured at record time); the resolver
// rewrites it back to local source under repoRoot.
export const FIXTURE_ORIGIN = "http://127.0.0.1:60832";

// --- CI-gating paths: write minimal recordings to a temp dir and drive the real commands. ---
export const tmpDir = mkdtempSync(path.join(os.tmpdir(), "wpd-test-"));

// A minimal recording carries a meta stamped with the CURRENT schema epoch, so the readers'
// schema gate (model/artifact.ts) lets it through; the count/timing tests exercise the gate logic,
// not the schema guard.
export function writeRecording(name, summaryOverrides) {
  return writeSchemaArtifact(name, "3", summaryOverrides);
}

/** Like writeRecording, but the caller pins the schema epoch (to exercise the reject path). */
export function writeSchemaArtifact(name, schemaVersion, summaryOverrides) {
  const summary = {
    wallMs: null, inpMs: null, scriptingMs: 0,
    layoutCount: 0, styleCount: 0, paintCount: 0,
    forcedLayoutCount: 0, layoutInvalidations: 0, paintInvalidations: 0, styleInvalidations: 0,
    longTaskCount: 0, totalEvents: 0, perIteration: [], stats: null,
    ...summaryOverrides,
  };
  const meta = { schemaVersion, passes: ["default"], driver: false };
  const file = path.join(tmpDir, name);
  // A minimal non-stepped recording: the run span only (no bar), so assert gates the run summary.
  writeFileSync(file, JSON.stringify({ meta, summary, spans: [] }), "utf8");
  return file;
}

// Run a command with console.log silenced and process.exitCode isolated; returns the exit code.
export async function captureExitCode(run) {
  const priorExit = process.exitCode;
  const priorLog = console.log;
  process.exitCode = undefined;
  console.log = () => {};
  try {
    await run();
    return process.exitCode;
  } finally {
    console.log = priorLog;
    process.exitCode = priorExit;
  }
}

// The sourcemap warning must fire when the package rollup is a lie and stay quiet when it is not.
// These pin BOTH directions, which the previous version of this comment CLAIMED to do while
// actually testing node builtins twice -- and that gap let a regression ship where the warning went
// silent on exactly the local minified bundle it exists for.
export function remoteProfile(url) {
  return {
    nodes: [
      { id: 1, callFrame: { functionName: "(root)", scriptId: "0", url: "", lineNumber: -1, columnNumber: -1 }, children: [2] },
      { id: 2, callFrame: { functionName: "hot", scriptId: "1", url, lineNumber: 0, columnNumber: 0 }, hitCount: 1 },
    ],
    startTime: 0,
    endTime: 1000,
    samples: [2],
    timeDeltas: [1000],
  };
}

// Fixtures below are REAL captures from headless Chrome against test/fixtures/slow-handler.html
// (a click handler that busy-waits a known 45ms), not hand-written shapes. An earlier version of
// this test invented the numbers, labelled them measured, and asserted only two of the three parts
// -- which let a negative presentation delay ship green. Assert all three, and assert the sum.
export const eventTiming = (name, startTime, processingStart, processingEnd, duration, interactionId) => ({
  name, startTime, processingStart, processingEnd, duration, interactionId,
});

// A plain page.click: every event reaches the same paint, so all three share one duration.
export const PLAIN_CLICK = [
  eventTiming("pointerover", 37.1, 37.3, 37.3, 64, 0),
  eventTiming("mouseover", 37.1, 37.3, 37.3, 64, 0),
  eventTiming("pointerdown", 37.2, 37.4, 37.4, 64, 6694),
  eventTiming("mousedown", 37.2, 37.4, 37.4, 64, 0),
  eventTiming("pointerup", 37.3, 37.7, 37.7, 64, 6694),
  eventTiming("mouseup", 37.3, 37.7, 37.7, 64, 0),
  eventTiming("click", 37.3, 37.7, 82.8, 64, 6694),
];

// A HELD click (delay 250, i.e. an ordinary human press). The interaction spans TWO paints:
// pointerdown painted at 43.3 (duration 24), pointerup/click at 336.1 (duration 64).
export const HELD_CLICK = [
  eventTiming("pointerover", 19.3, 19.4, 19.5, 24, 0),
  eventTiming("pointerdown", 19.3, 19.5, 19.5, 24, 6747),
  eventTiming("pointerup", 272.1, 272.4, 272.5, 64, 6747),
  eventTiming("mouseup", 272.1, 272.5, 272.5, 64, 0),
  eventTiming("click", 272.1, 272.5, 317.7, 64, 6747),
];

export const nonNegative = (split, label) => {
  for (const [part, value] of Object.entries(split))
    assert.ok(value >= 0, `${label}: ${part} must not be negative, got ${value}`);
};
