import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startStaticServer } from "../../dist/browser/server.js";

const tempRoot = () => mkdtempSync(path.join(os.tmpdir(), "wpd-server-listen-"));

// B-05: a listen failure (EADDRINUSE/EPERM on the loopback bind) fires an asynchronous 'error' event,
// not a throw from listen(). It must surface as a REJECTED promise (so record's normal `record
// failed:` path reports it and exits 1), never an uncaught 'error' that crashes the process.
test("startStaticServer: a listen failure rejects (not an uncaught 'error'), naming the cause", async () => {
  const originalListen = net.Server.prototype.listen;
  // Force the bind to fail the way the OS would: emit 'error' asynchronously and never call the
  // listen callback. Without the server's own 'error' listener this would be an uncaught exception.
  net.Server.prototype.listen = function patchedListen() {
    queueMicrotask(() =>
      this.emit(
        "error",
        Object.assign(new Error("listen EADDRINUSE: address already in use 127.0.0.1"), {
          code: "EADDRINUSE",
        }),
      ),
    );
    return this;
  };
  try {
    await assert.rejects(startStaticServer(tempRoot()), /EADDRINUSE/);
  } finally {
    net.Server.prototype.listen = originalListen;
  }
});

// The happy path is unchanged: it resolves to a loopback server that closes cleanly.
test("startStaticServer: a successful listen resolves to a loopback server and closes cleanly", async () => {
  const server = await startStaticServer(tempRoot());
  assert.ok(server.url.startsWith("http://127.0.0.1:"), "binds loopback");
  assert.ok(server.port > 0, "reports the bound port");
  await server.close();
});
