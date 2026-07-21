import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseGeckoLocation,
  parseGecko,
  geckoToRawCpuProfile,
  geckoToRenderingEvents,
  geckoUserMeasures,
  layoutSlice,
} from "../../dist/profile/gecko.js";
import {
  buildGeckoSpanBreakdowns,
  computeGeckoCpuBreakdown,
} from "../../dist/profile/gecko-breakdown.js";
import { buildCpuModel, packagesByProfileNode } from "../../dist/profile/cpuprofile.js";
import { attachStacks } from "../../dist/trace/stacks.js";
import { findWindow } from "../../dist/trace/parse.js";
import { markForced } from "../../dist/trace/analysis.js";
import { firefoxDirtiedBy } from "../../dist/trace/firefox-dirtied.js";
import { analyzeThrash } from "../../dist/trace/thrash.js";
import { geckoFixture, repoRoot, FIXTURE_ORIGIN, syntheticGeckoDump } from "./helpers.mjs";

// --- Firefox Gecko profile converter (against a real trimmed shutdown dump) ---

test("parseGeckoLocation: named JS, anonymous, native, and non-resolvable urls", () => {
  // named function: line:col is the definition site, 1-based; trailing [NN] stripped
  assert.deepEqual(parseGeckoLocation("hashString (http://h/a.mjs:6:20)[43]"), {
    functionName: "hashString",
    url: "http://h/a.mjs",
    rawUrl: "http://h/a.mjs",
    line: 6,
    column: 20,
  });
  // anonymous top-level positioned frame
  assert.deepEqual(parseGeckoLocation("http://h/__blank__:1:8[28]"), {
    functionName: "",
    url: "http://h/__blank__",
    rawUrl: "http://h/__blank__",
    line: 1,
    column: 8,
  });
  // native label: no url, kept as a name so it buckets to (native) downstream
  assert.deepEqual(parseGeckoLocation("XRE_InitChildProcess"), {
    functionName: "XRE_InitChildProcess",
    url: "",
    rawUrl: "",
    line: null,
    column: null,
  });
  // self-hosted is JS but not on-disk/fetchable, so the url is dropped (-> (native))
  assert.equal(parseGeckoLocation("get (self-hosted:12:3)").url, "");
  // a WebDriver-automation frame keeps its chrome://remote/ url in rawUrl (for isToolFrameUrl) even
  // though the unresolvable url is stripped, so it drops out of the CPU chain downstream.
  const automation = parseGeckoLocation(
    "synthesizeMouseAtPoint (chrome://remote/content/external/EventUtils.js:598:34)",
  );
  assert.equal(automation.url, "");
  assert.equal(automation.rawUrl, "chrome://remote/content/external/EventUtils.js");
});

test("parseGecko: selects the content thread by its wpd:run marks and reads the window", () => {
  const context = parseGecko(geckoFixture);
  assert.equal(context.thread.name, "GeckoMain");
  assert.ok(context.windowStartMs != null && context.windowEndMs != null, "window resolved");
  assert.ok(context.windowEndMs > context.windowStartMs, "window is a positive interval");
  assert.ok(context.jsCategory >= 0, "JavaScript category located");
});

test("parseGecko throws rather than silently reporting an empty profile", () => {
  // No JavaScript category => no frame can be classified as JS => a model claiming ~0 scripting.
  const noJsCategory = {
    ...geckoFixture,
    meta: { ...geckoFixture.meta, categories: [{ name: "Other" }, { name: "Idle" }] },
  };
  assert.throws(() => parseGecko(noJsCategory), /no 'JavaScript' category/);
  assert.throws(() => parseGecko({ meta: geckoFixture.meta, threads: [] }), /no threads/);
});

test("geckoToRawCpuProfile -> buildCpuModel resolves hot JS to source with 1->0-based line", async () => {
  const context = parseGecko(geckoFixture);
  const raw = geckoToRawCpuProfile(context);
  // window-sliced: the two pre-window samples the fixture includes must be dropped
  assert.ok(raw.samples.length > 0 && raw.samples.length <= context.thread.samples.data.length);
  assert.equal(raw.samples.length, raw.timeDeltas.length);

  const model = await buildCpuModel(raw, {
    profilePath: "fixture.geckoprofile.json",
    meta: { tool: "wpd", version: "0.0.0", schemaVersion: "1", browser: "firefox" },
    sampleIntervalUs: 1000,
    serverUrl: FIXTURE_ORIGIN,
    root: repoRoot,
  });
  assert.ok(model.scriptingMs > 0, "non-zero sampled scripting time");
  const busywork = model.functions.find((fn) => fn.source?.includes("forces-layout.mjs"));
  assert.ok(busywork, "a busywork function resolved to its source file");
  assert.match(busywork.package, /wpd-examples|app/, "attributed to the example workspace package");
  // definition line is what V8 reports: the location string's :6 (hashString) -> resolved :6.
  // The frame stores it 0-based (5) and resolveCallFrame adds 1; assert we land on a real line.
  assert.match(busywork.source, /forces-layout\.mjs:\d+$/, "resolved to file:line");
  // native JS-engine builtins (JSRope::flatten etc.) must bucket as (native), never a real pkg
  const native = model.functions.filter((fn) => fn.package === "(native)");
  for (const fn of native) assert.ok(!fn.source || !fn.source.includes("node_modules"));
});

test("geckoToRawCpuProfile drops Firefox WebDriver-automation frames from the CPU model (item 4a)", async () => {
  const dump = syntheticGeckoDump();
  const thread = dump.threads[0];
  // A chrome://remote/ automation frame (EventUtils.synthesizeMouseAtPoint), JS category (3), sitting
  // directly under root so the whole sample is automation dispatch, not app code.
  const locationIndex =
    thread.stringTable.push(
      "synthesizeMouseAtPoint (chrome://remote/content/external/EventUtils.js:598:34)",
    ) - 1;
  const frameIndex = thread.frameTable.data.push([locationIndex, false, null, null, 597, 33, 3, 0]) - 1;
  const stackIndex = thread.stackTable.data.push([0, frameIndex]) - 1; // root->automation
  // Two busy in-window samples on it: without the drop it would top the function list.
  thread.samples.data.push([stackIndex, 14.5, 1000], [stackIndex, 15.5, 1000]);

  const context = parseGecko(dump);
  const raw = geckoToRawCpuProfile(context);
  const model = await buildCpuModel(raw, {
    profilePath: "auto.geckoprofile.json",
    meta: { tool: "wpd", version: "0.0.0", schemaVersion: "1", browser: "firefox" },
    sampleIntervalUs: 1000,
    serverUrl: "http://h",
    root: repoRoot,
  });
  assert.ok(
    !model.functions.some((fn) => fn.fn === "synthesizeMouseAtPoint"),
    "the automation frame never becomes a ranked CPU function",
  );
  // The app's own JS still resolves (the drop is anchored, not a blanket JS cull).
  assert.ok(
    model.functions.some((fn) => fn.fn === "hashString" || fn.fn === "run"),
    "the app's own frames survive",
  );
  // The automation samples' wall tiles into the reconciling bar's browser slice, never js.
  const packageByNode = await packagesByProfileNode(raw, { serverUrl: "http://h", root: repoRoot });
  const breakdown = computeGeckoCpuBreakdown(raw, packageByNode, model.totalMs);
  assert.ok(breakdown.slices.browser.ms > 0, "automation dispatch tiles into the browser slice");
});

test("geckoToRenderingEvents -> attachStacks/markForced yields windowed + forced layout blame", async () => {
  const context = parseGecko(geckoFixture);
  const events = geckoToRenderingEvents(context);
  // UserTiming marks become usertiming events so findWindow locates the window
  const window = findWindow(events);
  assert.ok(window.startTs != null && window.endTs != null, "run window found from marks");
  const kinds = new Set(events.map((event) => event.kind));
  assert.ok(kinds.has("usertiming"), "usertiming events present");
  assert.ok(kinds.has("style") || kinds.has("layout"), "at least one Reflow/Styles event");

  await attachStacks(events, FIXTURE_ORIGIN, repoRoot);
  markForced(events);
  const forced = events.filter((event) => event.forced && event.at);
  assert.ok(forced.length > 0, "a style/layout event with a JS cause was flagged forced");
  assert.ok(
    (forced[0].kind === "style" || forced[0].kind === "layout") && forced[0].at.length > 0,
  );
});

// --- Firefox reconciling-bar style/layout label split (layoutSlice) ---

test("layoutSlice: style-wrapper labels bucket to style; the font trap and ` Layout` sibling stay layout", () => {
  // servo recalc scopes (the labels that always catch real style work)
  assert.equal(layoutSlice("Styles"), "style");
  assert.equal(layoutSlice("Style computation"), "style");
  assert.equal(layoutSlice("CSS parsing"), "style");
  // widened wrapper / diff / stylist labels that otherwise mis-bucket to layout
  assert.equal(layoutSlice("RestyleManager::ProcessRestyledFrames"), "style");
  assert.equal(layoutSlice("RestyleManager::ProcessPendingRestyles"), "style");
  assert.equal(layoutSlice("ComputedStyle::CalcStyleDifference"), "style");
  assert.equal(layoutSlice("Update stylesheet information"), "style");
  // the ` Style`-suffixed flush wrapper is style; its ` Layout` sibling stays layout
  assert.equal(layoutSlice("PresShell::DoFlushPendingNotifications Style"), "style");
  assert.equal(layoutSlice("PresShell::DoFlushPendingNotifications Layout"), "layout");
  // real reflow and frame construction stay layout
  assert.equal(layoutSlice("Reflow http://h/app.mjs"), "layout");
  assert.equal(layoutSlice("nsCSSFrameConstructor::ContentRangeInserted"), "layout");
  // anchoring trap: font matching contains the substring "Style" but is Graphics work, not style.
  // A bare /Style/ test would wrongly claim it; the anchored prefix/suffix rule must not.
  assert.equal(layoutSlice("CTFontFamily::FindStyleVariations .SF NS"), "layout");
});

// --- Firefox read-site forced blame (js,cpu mechanisms) ---

test("read-site blame: names the read line + property, never the write line", async () => {
  const context = parseGecko(geckoFixture);
  const events = geckoToRenderingEvents(context);
  await attachStacks(events, FIXTURE_ORIGIN, repoRoot);
  markForced(events);

  const sampled = events.filter((event) => event.sampled && event.at);
  assert.ok(sampled.length > 0, "sampled read-site events produced");
  const lines = new Set(
    sampled.map((event) => Number(event.at.match(/forces-layout\.mjs:(\d+)/)?.[1])),
  );
  // The write sites (bump/bumpDoc definitions + style assignments) must never appear as read blame.
  for (const writeLine of [13, 15, 16, 17, 19, 21])
    assert.ok(!lines.has(writeLine), `write line ${writeLine} must not be a read-site blame line`);
  // At least one exact geometry-read line from forces-layout.mjs's read set.
  assert.ok([46, 64, 83, 87, 96, 103, 104].some((line) => lines.has(line)), "an exact read line");
  const properties = new Set(
    sampled.map((event) => event.args?.data?.property).filter(Boolean),
  );
  assert.ok(
    [...properties].some((property) => /offsetWidth|scroll|client|Height|Width/.test(property)),
    "the forcing DOM property is named",
  );
  // The marker events keep providing the forced COUNT (forced, but no `at`, so out of blame).
  const markerForced = events.filter((event) => event.forced && !event.sampled);
  assert.ok(markerForced.length > 0, "marker flushes still flagged forced for the count");
  assert.ok(markerForced.every((event) => !event.at), "marker forced events carry no blame line");
});

// --- Firefox --deep dirtied-by write report (Gecko cause stacks, first-invalidation-only) ---

test("firefox --deep: cause stacks resolve to write lines on the forced markers, off `at`", async () => {
  const context = parseGecko(geckoFixture);
  const events = geckoToRenderingEvents(context);
  await attachStacks(events, FIXTURE_ORIGIN, repoRoot);
  markForced(events);

  // The forced Reflow/Styles markers now carry a resolved WRITE line (event.dirtiedBy), from the
  // Gecko cause stack -- but never an `at` (that stays the read-site blame answer).
  const markerForced = events.filter((event) => event.forced && !event.sampled);
  assert.ok(markerForced.length > 0, "forced markers present");
  const withWrite = markerForced.filter((event) => event.dirtiedBy);
  assert.ok(withWrite.length > 0, "a forced marker carries a resolved dirtied-by write");
  assert.ok(markerForced.every((event) => !event.at), "the write is never surfaced as a blame `at`");
  for (const event of withWrite)
    assert.match(event.dirtiedBy.at, /forces-layout\.mjs:\d+/, "the write resolves to a source line");
});

test("firefox --deep: the dirtied-by rollup is first-invalidation-only and never fabricates parity", async () => {
  const context = parseGecko(geckoFixture);
  const events = geckoToRenderingEvents(context);
  await attachStacks(events, FIXTURE_ORIGIN, repoRoot);
  markForced(events);
  const window = findWindow(events);

  const report = firefoxDirtiedBy(events, window.startTs);
  assert.ok(report, "a dirtied-by report is produced");
  assert.equal(report.semantic, "first-invalidation", "the scope marker so it is never read as chrome's full set");
  assert.ok(report.writes.length > 0, "at least one write line");
  for (const write of report.writes) {
    assert.match(write.at, /forces-layout\.mjs:\d+/, "write attributed to the example source");
    assert.ok(write.count >= 1, "each write carries a flush count");
    assert.ok(write.kinds.every((kind) => kind === "layout" || kind === "style"), "kinds are layout/style");
  }
  // Write != read: the dirtied-by write lines are never the geometry-read lines the sampled read-site
  // blame names (46, 64, 83, ... in forces-layout.mjs).
  const writeLines = new Set(report.writes.map((write) => Number(write.at.match(/:(\d+):/)?.[1])));
  for (const readLine of [46, 64, 83, 87, 96, 103, 104])
    assert.ok(!writeLines.has(readLine), `read line ${readLine} must never be a dirtied-by write`);

  // Never-fake-parity: the thrash detector observes NOTHING on these events (no invalidation-kind
  // records to walk), so a firefox recording produces no thrash rollup and no dirtied-by-read-site.
  const thrash = analyzeThrash(events, window.startTs);
  assert.equal(thrash.report.count, 0, "no thrash steps (firefox has no full write set)");
  assert.equal(Object.keys(thrash.dirtiedByReadSite).length, 0, "no read-site dirtied-by fabricated");
});

test("firefoxDirtiedBy: null when no forced flush carried a cause (not an empty-but-present report)", () => {
  assert.equal(firefoxDirtiedBy([], null), null, "empty log -> null");
  // A sampled read-site event carries no dirtiedBy, so it must not produce a write report.
  const sampledOnly = [{ id: 0, name: "Layout", ts: 5, dur: 1, ph: "X", kind: "layout", sampled: true }];
  assert.equal(firefoxDirtiedBy(sampledOnly, null), null, "sampled read events never make a write report");
});

// --- Firefox reconciling breakdown (threadCPUDelta idle + category rollup) ---

test("geckoToRawCpuProfile: threadCPUDelta ~0 samples route to idle; the bar tiles exactly", async () => {
  const context = parseGecko(syntheticGeckoDump());
  const raw = geckoToRawCpuProfile(context);
  assert.ok(raw.gecko, "a populated threadCPUDelta column attaches breakdown data");
  // Window [10,16] keeps 5 samples (the pre-window one at t=5 is dropped).
  assert.equal(raw.samples.length, 5);
  // Two cpu~0 samples classify idle (one had a js stack, proving cpu overrides the stack).
  const idleCount = raw.gecko.sampleSlices.filter((slice) => slice === "idle").length;
  assert.equal(idleCount, 2, "both ~0-CPU samples are idle");
  assert.ok(raw.gecko.sampleSlices.includes("layout"), "the forced-reflow sample is layout");
  assert.ok(raw.gecko.sampleSlices.includes("js"), "the busywork sample is js");

  const model = await buildCpuModel(raw, {
    profilePath: "synthetic.geckoprofile.json",
    meta: { tool: "wpd", version: "0", schemaVersion: "1", browser: "firefox" },
    sampleIntervalUs: 1000,
    serverUrl: FIXTURE_ORIGIN,
    root: repoRoot,
  });
  const breakdown = model.breakdown;
  assert.ok(breakdown, "firefox breakdown emitted (gate lifted)");
  assert.ok(breakdown.slices.style && breakdown.slices.layout, "style/layout slices present");
  assert.ok(breakdown.slices.idle.ms > 0, "idle slice is non-zero");
  // The bar tiles the window EXACTLY: Σ slices === wallMs (no residual beyond float dust).
  const sliceSum =
    breakdown.slices.js.ms +
    breakdown.slices.style.ms +
    breakdown.slices.layout.ms +
    breakdown.slices.browser.ms +
    breakdown.slices.gc.ms +
    breakdown.slices.idle.ms;
  assert.ok(Math.abs(sliceSum - breakdown.wallMs) < 1e-6, "slices tile the wall");
  assert.equal(breakdown.residualMs, undefined, "no residual");
});

test("null threadCPUDelta keeps old behavior: no breakdown data, never a fabricated idle", () => {
  // The trimmed real fixture predates the CPU feature (no threadCPUDelta column).
  const raw = geckoToRawCpuProfile(parseGecko(geckoFixture));
  assert.equal(raw.gecko, undefined, "no CPU signal -> no breakdown data attached");
});

test("mark bridge: user performance.measure spans get their own tiling breakdown; wpd:* excluded", async () => {
  const context = parseGecko(syntheticGeckoDump());
  const measures = geckoUserMeasures(context);
  assert.deepEqual(
    measures.map((measure) => measure.label),
    ["paint-phase"],
    "only the user measure, not wpd:run",
  );
  const raw = geckoToRawCpuProfile(context);
  const packageByNode = await packagesByProfileNode(raw, { serverUrl: FIXTURE_ORIGIN, root: repoRoot });
  const spans = buildGeckoSpanBreakdowns(raw, packageByNode, measures, { startTs: 10, endTs: 16 });
  const measureSpan = spans.find((span) => span.kind === "measure" && span.label === "paint-phase");
  assert.ok(measureSpan, "measure span produced");
  const slices = measureSpan.breakdown.slices;
  const sum =
    slices.js.ms +
    slices.style.ms +
    slices.layout.ms +
    slices.gc.ms +
    slices.other.ms +
    slices.idle.ms;
  assert.ok(Math.abs(sum - measureSpan.breakdown.wallMs) < 1e-6, "span breakdown tiles its window");
  // Firefox paint is off-main-thread: the stored bar reports it not-measured (null), never a fake 0.
  // Adding a user performance.measure must NOT turn paint into a measured 0 (finding F04).
  assert.equal(slices.paint, null, "paint is not-measured (null) on firefox stored bars");
  const runSpan = spans.find((span) => span.kind === "run");
  assert.ok(runSpan, "run span produced alongside the measure");
  assert.equal(runSpan.breakdown.slices.paint, null, "firefox run stored bar paint is null too");
});
