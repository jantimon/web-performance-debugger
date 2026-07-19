import { test } from "node:test";
import assert from "node:assert/strict";
import { isToolFrameUrl } from "../../dist/trace/stacks.js";

// F11: a driver-mode USER page.evaluate callback is stamped `pptr:evaluate;<user call site>` by
// puppeteer, the same scheme wpd's own injected helpers carry. Dropping the whole `pptr:` family
// silently erased the user's evaluated code from blame/cpu; the filter must drop only wpd's OWN
// injection points (driver marks/observer/settle, bench harness) and let user frames survive.

// puppeteer builds the sourceURL as `pptr:<fn>;<encodeURIComponent(call site)>`.
const pptr = (site) => `pptr:evaluate;${encodeURIComponent(site)}`;

test("isToolFrameUrl drops wpd's own injected page.evaluate frames", () => {
  assert.equal(isToolFrameUrl(pptr("settle (/home/u/app/node_modules/@jantimon/web-performance-debugger/dist/browser/driver.js:185:31)")), true);
  assert.equal(isToolFrameUrl(pptr("runPass (/repo/dist/record/runpass.js:222:10)")), true);
  assert.equal(isToolFrameUrl("pptr:internal"), true, "puppeteer internals stay tool frames");
  assert.equal(isToolFrameUrl("debugger://foo"), true);
  assert.equal(isToolFrameUrl("http://127.0.0.1:5000/__wpd_blank__:1:1"), true);
  assert.equal(isToolFrameUrl("file:///repo/dist/runtime/node.js:9:5"), true);
});

test("isToolFrameUrl drops wpd's injected frames when the call site is a Windows path", () => {
  const windowsSite = String.raw`settle (C:\Users\u\app\node_modules\@jantimon\web-performance-debugger\dist\browser\driver.js:185:31)`;
  assert.equal(isToolFrameUrl(pptr(windowsSite)), true);
  const windowsUserSite = String.raw`run (C:\Users\u\app\steps.mjs:12:20)`;
  assert.equal(isToolFrameUrl(pptr(windowsUserSite)), false, "a user's Windows call site survives");
});

test("isToolFrameUrl keeps a user's driver-mode page.evaluate callback (F11)", () => {
  // The user's own module drives the page; its evaluated callback must reach blame/cpu.
  assert.equal(isToolFrameUrl(pptr("(/home/u/app/steps.mjs:12:20)")), false);
  // Even a user file literally named driver.mjs (common) is not under wpd's browser/ dir, so it survives.
  assert.equal(isToolFrameUrl(pptr("run (/home/u/app/driver.mjs:8:14)")), false);
  // A plain served source url is never a tool frame.
  assert.equal(isToolFrameUrl("http://127.0.0.1:5000/src/app.js"), false);
  assert.equal(isToolFrameUrl(undefined), false);
});
