import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readLayoutScope,
  readStyleScope,
  spanScope,
  scopeByReadSite,
} from "../../dist/trace/scope.js";
import { buildSpans } from "../../dist/model/spans.js";

// Per-flush layout/style SCOPE (docs/dev/rendering-counts.md "Per-flush layout/style scope"):
//  - style scope and layout scope are different denominators, never merged;
//  - per span a max/distribution, NEVER a sum;
//  - the contained-flush note fires only on partialLayout;
//  - fields absent (never 0) on a trace predating the scope args

// A chrome Layout event with beginData/endData scope args
const layout = (id, dirty, total, partial = false, root = "#document") => ({
  id,
  name: "Layout",
  ts: id,
  dur: 100,
  ph: "X",
  kind: "layout",
  args: {
    beginData: { dirtyObjects: dirty, totalObjects: total, partialLayout: partial },
    endData: { layoutRoots: [{ nodeName: root, depth: 1 }] },
  },
});
// A chrome UpdateLayoutTree event with the elementCount END arg
const recalc = (id, elementCount) => ({
  id,
  name: "UpdateLayoutTree",
  ts: id,
  dur: 50,
  ph: "X",
  kind: "style",
  args: { beginData: {}, elementCount },
});
// A firefox style marker: elementsStyled lives under args.data (the Gecko analog of elementCount)
const geckoStyle = (id, elementsStyled) => ({
  id,
  name: "RecalcStyles",
  ts: id,
  dur: 50,
  ph: "X",
  kind: "style",
  args: { data: { elementsStyled } },
});

test("readLayoutScope pulls dirty/total/partial/root; undefined on non-layout and on missing args", () => {
  assert.deepEqual(readLayoutScope(layout(1, 5, 18)), {
    dirty: 5,
    total: 18,
    partial: false,
    root: "#document",
  });
  assert.deepEqual(readLayoutScope(layout(1, 201, 2006, true, "DIALOG")), {
    dirty: 201,
    total: 2006,
    partial: true,
    root: "DIALOG",
  });
  // A style event is not a Layout flush
  assert.equal(readLayoutScope(recalc(1, 8)), undefined);
  // An old trace with no beginData scope fields -> absent, never a fabricated 0
  assert.equal(
    readLayoutScope({ id: 1, name: "Layout", ts: 1, dur: 1, ph: "X", kind: "layout", args: {} }),
    undefined,
  );
  // A sampled blame annotation is not a measured flush
  assert.equal(readLayoutScope({ ...layout(1, 5, 18), sampled: true }), undefined);
});

test("readStyleScope reads chrome elementCount and firefox elementsStyled; undefined otherwise", () => {
  assert.equal(readStyleScope(recalc(1, 8)), 8);
  assert.equal(readStyleScope(geckoStyle(1, 13)), 13);
  assert.equal(readStyleScope(layout(1, 5, 18)), undefined);
  // A style event with no count (an old trace) -> absent
  assert.equal(
    readStyleScope({ id: 1, name: "UpdateLayoutTree", ts: 1, dur: 1, ph: "X", kind: "style", args: {} }),
    undefined,
  );
});

test("spanScope: p50/max distribution, NEVER a sum", () => {
  // Layout flushes 5, 20, 3 -> sorted 3,5,20 -> p50 5, max 20 (NOT the sum 28)
  const events = [layout(1, 5, 18), layout(2, 20, 18), layout(3, 3, 18)];
  const scope = spanScope(events);
  assert.deepEqual(scope.layoutObjects, { p50: 5, max: 20, flushes: 3 });
  assert.ok(scope.layoutObjects.max < 28, "max is the widest flush, never the sum");
  // No style flush in this window -> no style stats, never a 0
  assert.equal(scope.elementsStyled, undefined);
  assert.equal(scope.contained, undefined);
});

test("spanScope: a style-only window produces elementCount stats and NO layout stats", () => {
  const scope = spanScope([recalc(1, 8), recalc(2, 1), recalc(3, 35)]);
  // 1,8,35 -> p50 8, max 35
  assert.deepEqual(scope.elementsStyled, { p50: 8, max: 35, flushes: 3 });
  assert.equal(scope.layoutObjects, undefined, "a color-only change emits no Layout event");
});

test("spanScope: contained note fires only on partialLayout, with a sample root", () => {
  // Two whole-document flushes, one contained -> contained.flushes 1, sampleRoot DIALOG
  const scope = spanScope([
    layout(1, 5, 2006),
    layout(2, 201, 201, true, "DIALOG"),
    layout(3, 4, 2006),
  ]);
  assert.deepEqual(scope.contained, { flushes: 1, sampleRoot: "DIALOG" });
  // Whole-document-only -> no contained note
  const whole = spanScope([layout(1, 5, 2006), layout(2, 4, 2006)]);
  assert.equal(whole.contained, undefined);
});

test("spanScope (firefox): style scope only, layout scope absent (never a fake zero)", () => {
  // Gecko markers carry elementsStyled but NO dirtyObjects; the layout side stays absent
  const scope = spanScope([geckoStyle(1, 13), geckoStyle(2, 56), geckoStyle(3, 30)]);
  // 13,30,56 -> p50 30, max 56
  assert.deepEqual(scope.elementsStyled, { p50: 30, max: 56, flushes: 3 });
  assert.equal(scope.layoutObjects, undefined, "Gecko Reflow markers carry no layout scope");
  assert.equal(scope.contained, undefined);
});

test("spanScope: an even flush count picks the average of the two middles", () => {
  // 2,4,6,8 -> p50 (4+6)/2 = 5
  const scope = spanScope([layout(1, 2, 10), layout(2, 4, 10), layout(3, 6, 10), layout(4, 8, 10)]);
  assert.equal(scope.layoutObjects.p50, 5);
  assert.equal(scope.layoutObjects.max, 8);
});

test("spanScope: a window with no scope-bearing flush returns undefined (stores no field)", () => {
  const noArgs = [{ id: 1, name: "Layout", ts: 1, dur: 1, ph: "X", kind: "layout", args: {} }];
  assert.equal(spanScope(noArgs), undefined);
  assert.equal(spanScope([]), undefined);
});

test("scopeByReadSite: the WIDEST flush per read-site line (blame-row enrichment shape)", () => {
  // Two flushes at one line (dirty 5 and 20); the row reports the widest (20/18) + the max styled
  const events = [
    { ...layout(1, 5, 18), at: "a.mjs:10:2" },
    { ...layout(2, 20, 18), at: "a.mjs:10:2" },
    { ...recalc(3, 8), at: "a.mjs:10:2" },
    { ...recalc(4, 1), at: "a.mjs:10:2" },
    { ...layout(5, 3, 2006, true, "DIALOG"), at: "b.mjs:20:4" },
  ];
  const map = scopeByReadSite(events);
  assert.deepEqual(map.get("a.mjs:10:2"), { layoutObjects: { dirty: 20, total: 18 }, elementsStyled: 8 });
  assert.deepEqual(map.get("b.mjs:20:4"), {
    layoutObjects: { dirty: 3, total: 2006 },
    containedRoot: "DIALOG",
  });
});

// A minimal reconciling bar so buildSpans (model/spans.ts) accepts the span
const emptyBreakdown = () => ({
  wallMs: 10,
  slices: {
    js: { ms: 0, byPackage: {} },
    style: { ms: 0 },
    layout: { ms: 0 },
    paint: { ms: 0 },
    gc: { ms: 0 },
    other: { ms: 0 },
    idle: { ms: 10 },
  },
});

test("JSON view: a Span's scope threads onto its SpanEntry (query spans / query span JSON)", () => {
  const scope = {
    layoutObjects: { p50: 14, max: 3350, flushes: 114 },
    elementsStyled: { p50: 35, max: 2645, flushes: 906 },
    contained: { flushes: 2, sampleRoot: "DIALOG" },
  };
  const spans = [
    {
      label: "run",
      kind: "run",
      aggregation: "sum",
      wallMs: 10,
      breakdown: emptyBreakdown(),
      counts: {
        layoutCount: null,
        styleCount: null,
        paintCount: null,
        forcedLayoutCount: null,
        layoutInvalidations: null,
        styleInvalidations: null,
        longTaskCount: null,
      },
      scope,
    },
  ];
  const result = buildSpans(spans, undefined, "chrome", 1);
  assert.deepEqual(result.spans[0].scope, scope, "scope survives onto the SpanEntry JSON view");
  // A span with no scope carries no field (old recordings / scope-less captures stay old-shape)
  const bare = buildSpans([{ ...spans[0], scope: undefined }], undefined, "chrome", 1);
  assert.equal("scope" in bare.spans[0], false, "no scope field when the span carried none");
});

test("scopeByReadSite: events with no `at`, no args, or sampled produce no entry", () => {
  const events = [
    layout(1, 5, 18), // no `at`
    { ...layout(2, 5, 18), at: "x.mjs:1:1", sampled: true }, // sampled read-site, not a flush
    { id: 3, name: "Layout", ts: 3, dur: 1, ph: "X", kind: "layout", args: {}, at: "y.mjs:1:1" }, // no scope args
  ];
  const map = scopeByReadSite(events);
  assert.equal(map.size, 0);
});
