import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePageOption } from "../../dist/record/page-option.js";

// The host-page option (--url, with --html as its hidden alias) accepts a live URL OR a local HTML
// file. resolvePageOption is the pure detection order: (1) a `://` scheme -> URL, (2) an existing
// path -> local HTML, (3) a host-ish shape -> URL with http:// assumed, (4) neither -> a dual
// file/URL error. `fileExists` is injected so the order is tested without touching disk. These are
// the cases a first-time user's typo lands on, so assert on the resolved kind AND the error wording.
const noFiles = () => false;
const allFiles = () => true;

test("an https URL resolves to a url with no scheme assumed", () => {
  const resolved = resolvePageOption("https://example.com/app", noFiles);
  assert.deepEqual(resolved, {
    kind: "url",
    url: "https://example.com/app",
    schemeAssumed: false,
  });
});

test("an http URL resolves to a url", () => {
  const resolved = resolvePageOption("http://localhost:5173", noFiles);
  assert.equal(resolved.kind, "url");
  assert.equal(resolved.url, "http://localhost:5173");
  assert.equal(resolved.schemeAssumed, false);
});

test("an existing path resolves to the local-HTML case", () => {
  const resolved = resolvePageOption("examples/react-counter/dist/index.html", allFiles);
  assert.deepEqual(resolved, {
    kind: "html",
    html: "examples/react-counter/dist/index.html",
  });
});

test("a scheme wins over an existing file (a file:// path never becomes local HTML)", () => {
  // Even if such a file existed, `://` is decided first: file:// points at the plain-path form.
  assert.throws(
    () => resolvePageOption("file:///tmp/page.html", allFiles),
    /pass its plain path instead/,
  );
});

test("localhost:3000 with no scheme resolves to a url with http:// assumed", () => {
  const resolved = resolvePageOption("localhost:3000", noFiles);
  assert.deepEqual(resolved, {
    kind: "url",
    url: "http://localhost:3000",
    schemeAssumed: true,
  });
});

test("127.0.0.1:8080/path resolves to a url with http:// assumed", () => {
  const resolved = resolvePageOption("127.0.0.1:8080/path", noFiles);
  assert.deepEqual(resolved, {
    kind: "url",
    url: "http://127.0.0.1:8080/path",
    schemeAssumed: true,
  });
});

test("[::1] loopback resolves to a url with http:// assumed", () => {
  const resolved = resolvePageOption("[::1]:9000", noFiles);
  assert.equal(resolved.url, "http://[::1]:9000");
  assert.equal(resolved.schemeAssumed, true);
});

test("bare localhost (no port) resolves to a url with http:// assumed", () => {
  const resolved = resolvePageOption("localhost", noFiles);
  assert.equal(resolved.url, "http://localhost");
  assert.equal(resolved.schemeAssumed, true);
});

test("an explicit host:port resolves to a url with http:// assumed", () => {
  const resolved = resolvePageOption("dev.example.com:8080", noFiles);
  assert.equal(resolved.url, "http://dev.example.com:8080");
  assert.equal(resolved.schemeAssumed, true);
});

test("a nonexistent path that is not host-ish yields the dual file/URL error", () => {
  assert.throws(() => resolvePageOption("./nope.html", noFiles), (error) => {
    assert.match(error.message, /no such file/);
    assert.match(error.message, /not a recognizable URL/);
    return true;
  });
});

test("a file:// URL yields the plain-path pointer error", () => {
  assert.throws(
    () => resolvePageOption("file:///Users/me/page.html", noFiles),
    /a file:\/\/ URL names a local file/,
  );
});

test("a non-http(s) scheme is rejected as unsupported", () => {
  assert.throws(
    () => resolvePageOption("ftp://example.com/page.html", noFiles),
    /only http:\/\/ and https:\/\/ URLs are supported/,
  );
});

test("C:\\path on a non-windows box is a dual error, never read as a scheme", () => {
  // Requiring `://` for the scheme branch is what keeps a Windows drive path out of it: with no
  // `://` and no matching file, `C:\nope` falls through to the dual error, not a `C:` scheme.
  assert.throws(() => resolvePageOption("C:\\nope", noFiles), (error) => {
    assert.match(error.message, /no such file/);
    assert.match(error.message, /not a recognizable URL/);
    assert.doesNotMatch(error.message, /scheme/);
    return true;
  });
});

test("C:/path (forward slashes) is also a dual error, not a scheme", () => {
  assert.throws(() => resolvePageOption("C:/nope", noFiles), /no such file/);
});
