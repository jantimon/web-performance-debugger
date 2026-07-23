import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { scanTraceEvents, toRawTraceEvents } from "../../dist/trace/scan.js";

const encode = (text) => new TextEncoder().encode(text);
const scanText = (text) => [...scanTraceEvents(encode(text))];

test("scanTraceEvents: object envelope, bare array, and empties all yield the same events", () => {
  const events = [
    { name: "A", ph: "X", ts: 1 },
    { name: "B", ph: "I", ts: 2 },
  ];
  assert.deepEqual(scanText(JSON.stringify({ traceEvents: events })), events, "object envelope");
  assert.deepEqual(scanText(JSON.stringify(events)), events, "bare top-level array");
  assert.deepEqual(scanText("[]"), [], "empty bare array");
  assert.deepEqual(scanText('{"traceEvents":[]}'), [], "empty traceEvents");
  assert.deepEqual(scanText("{}"), [], "empty object (no traceEvents)");
  assert.deepEqual(scanText("   "), [], "whitespace-only input");
  assert.deepEqual(scanText(""), [], "empty input");
});

test("scanTraceEvents: metadata fields before AND after traceEvents still reach the consumer", () => {
  // Only the traceEvents elements are yielded; the surrounding metadata is skipped, not parsed.
  const events = [{ name: "A", ph: "X", ts: 1, args: { data: { nested: [1, 2, 3] } } }];
  const before = { metadata: { source: "x" }, otherArray: [{ k: 1 }], traceEvents: events };
  const after = { traceEvents: events, metadata: { source: "y" }, displayTimeUnit: "ns" };
  assert.deepEqual(scanText(JSON.stringify(before)), events, "traceEvents after other fields");
  assert.deepEqual(scanText(JSON.stringify(after)), events, "traceEvents before other fields");
});

test("scanTraceEvents: strings with braces, brackets, commas, quotes, and unicode escapes", () => {
  const events = [
    { name: 'has { } [ ] , : "quote" chars', ph: "X", ts: 1 },
    { name: "escaped backslash \\ and quote \\\" together", ph: "X", ts: 2 },
    { name: "unicode é\u{1f600} and \\uXXXX-looking literal \\u0041", ph: "X", ts: 3 },
    { name: "]}]}fake structural bytes inside a string{[{[", ph: "X", ts: 4 },
  ];
  // JSON.stringify escapes these correctly; the scanner must isolate each element despite the
  // structural-looking bytes living inside strings.
  assert.deepEqual(scanText(JSON.stringify({ traceEvents: events })), events);
});

test("scanTraceEvents: deeply nested objects and arrays inside one event", () => {
  const events = [
    { name: "A", ph: "X", ts: 1, args: { data: { a: [{ b: [{ c: { d: [1, [2, [3]]] } }] }] } } },
    { name: "B", ph: "X", ts: 2, args: { list: [{}, [], { x: [] }] } },
  ];
  assert.deepEqual(scanText(JSON.stringify({ traceEvents: events })), events);
});

test("scanTraceEvents: whitespace between every structural token is tolerated", () => {
  const text = '  {  "traceEvents"  :  [  { "name" : "A" , "ph" : "X" , "ts" : 1 } , { "name":"B","ph":"X","ts":2 }  ]  ,  "metadata" : { }  }  ';
  assert.deepEqual(scanText(text), [
    { name: "A", ph: "X", ts: 1 },
    { name: "B", ph: "X", ts: 2 },
  ]);
});

test("scanTraceEvents: primitive-typed top-level metadata values are skipped", () => {
  // Values before traceEvents that are numbers/booleans/null/strings must be stepped over cleanly.
  const events = [{ name: "A", ph: "X", ts: 1 }];
  const text = JSON.stringify({
    number: 42,
    negative: -1.5e3,
    truthy: true,
    falsy: false,
    empty: null,
    label: "a string, with a comma and a } brace",
    traceEvents: events,
  });
  assert.deepEqual(scanText(text), events);
});

// Mirror trace/tracing.ts readStream: concatenate arbitrary-sized byte chunks into ONE Uint8Array.
function concatChunks(chunks) {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

test("scanTraceEvents: events spanning arbitrary chunk boundaries parse identically", () => {
  const events = Array.from({ length: 50 }, (_, index) => ({
    name: `event ${index} with a } brace and , comma`,
    ph: "X",
    ts: index,
    args: { data: { stack: [{ url: "http://x/y.js", line: index }] } },
  }));
  const bytes = encode(JSON.stringify({ traceEvents: events }));

  // 1-byte chunks: the harshest boundary split, every token crosses a chunk edge.
  const oneByte = [...bytes].map((byte) => Uint8Array.of(byte));
  assert.deepEqual([...scanTraceEvents(concatChunks(oneByte))], events, "1-byte chunks");

  // Odd, uneven chunk sizes.
  const odd = [];
  for (let offset = 0; offset < bytes.length; offset += 7) odd.push(bytes.subarray(offset, offset + 7));
  assert.deepEqual([...scanTraceEvents(concatChunks(odd))], events, "7-byte chunks");
});

test("scanTraceEvents: byte-exact parity with JSON.parse over a real trace fixture", () => {
  // v8-cpu-profiler-chunks.trimmed.json is a real ProfileChunk trace envelope with a leading _comment
  // metadata field before traceEvents.
  const text = readFileSync(
    fileURLToPath(new URL("../fixtures/v8-cpu-profiler-chunks.trimmed.json", import.meta.url)),
    "utf8",
  );
  const expected = JSON.parse(text).traceEvents;
  assert.deepEqual([...scanTraceEvents(encode(text))], expected, "element-for-element parity");
});

test("toRawTraceEvents: bytes, string, envelope, bare array, and generator all normalize alike", () => {
  const events = [{ name: "A", ph: "X", ts: 1 }];
  const asArray = (iterable) => [...iterable];
  assert.deepEqual(asArray(toRawTraceEvents(encode(JSON.stringify({ traceEvents: events })))), events, "bytes");
  assert.deepEqual(asArray(toRawTraceEvents(JSON.stringify({ traceEvents: events }))), events, "string");
  assert.deepEqual(asArray(toRawTraceEvents({ traceEvents: events })), events, "envelope object");
  assert.deepEqual(asArray(toRawTraceEvents(events)), events, "bare array");
  assert.deepEqual(asArray(toRawTraceEvents(scanTraceEvents(encode(JSON.stringify(events))))), events, "generator");
});

test("scanTraceEvents: a malformed array throws loudly rather than silently truncating", () => {
  assert.throws(() => scanText('{"traceEvents":[{"name":"A"} {"name":"B"}]}'), /malformed traceEvents array/);
});
