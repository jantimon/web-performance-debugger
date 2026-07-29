import { test } from "node:test";
import assert from "node:assert/strict";
import { splitReadSite } from "../../dist/commands/query.js";

// `query blame --format json` rows carry a STRUCTURED location ({source, line, column}) so a consumer
// reads the columns directly instead of parsing "file:line:col". splitReadSite parses from the RIGHT so
// a source that itself carries colons (a remote url with a port) keeps its host:port in `source`.

test("local file with line:col", () => {
  assert.deepEqual(splitReadSite("src/app.js:10:5"), { source: "src/app.js", line: 10, column: 5 });
});

test("line-only (a sampled frame with no column)", () => {
  assert.deepEqual(splitReadSite("src/app.js:10"), { source: "src/app.js", line: 10 });
});

test("no position keeps the whole string as the source", () => {
  assert.deepEqual(splitReadSite("(cdn.example.com)"), { source: "(cdn.example.com)" });
});

test("remote url with a port keeps host:port in source, splits only the trailing line:col", () => {
  assert.deepEqual(splitReadSite("https://host.example:443/x.js:12:7"), {
    source: "https://host.example:443/x.js",
    line: 12,
    column: 7,
  });
});
