import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { startStaticServer } from "../../dist/browser/server.js";

/** Send a raw request line to the server, bypassing a client's path normalization (fetch/undici
 * collapses `..` and `%2e%2e` before it leaves the process, so a traversal can only be exercised over
 * a raw socket). Returns the numeric status. */
function rawStatus(server, rawPath, hostHeader = "127.0.0.1") {
  const { port } = new URL(server.url);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), "127.0.0.1", () => {
      socket.write(`GET ${rawPath} HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`);
    });
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => (data += chunk));
    socket.on("end", () => resolve(Number(data.match(/^HTTP\/1\.1 (\d{3})/)?.[1])));
    socket.on("error", reject);
  });
}

function tempRoot() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wpd-server-cors-"));
  writeFileSync(path.join(dir, "secret.txt"), "cwd file (source, .env)");
  return dir;
}

test("no allowedOrigin (module/html mode): the server sends no CORS header, so no third-party site can read cwd files", async () => {
  const server = await startStaticServer(tempRoot());
  try {
    const response = await fetch(`${server.url}/secret.txt`, {
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.ok((await response.text()).length > 0);
  } finally {
    await server.close();
  }
});

test("allowedOrigin (--url bench mode): CORS names exactly the host origin, never a wildcard", async () => {
  const server = await startStaticServer(tempRoot(), "https://example.com");
  try {
    const toHost = await fetch(`${server.url}/secret.txt`, {
      headers: { Origin: "https://example.com" },
    });
    const toEvil = await fetch(`${server.url}/secret.txt`, {
      headers: { Origin: "https://evil.example" },
    });
    // Same value for both (constant, not reflected), and it is the host origin, not "*", so only the
    // host page can read the response; the browser refuses it for any other origin.
    assert.equal(toHost.headers.get("access-control-allow-origin"), "https://example.com");
    assert.equal(toEvil.headers.get("access-control-allow-origin"), "https://example.com");
    assert.notEqual(toHost.headers.get("access-control-allow-origin"), "*");
  } finally {
    await server.close();
  }
});

test("static server binds loopback only and blocks path traversal", async () => {
  const server = await startStaticServer(tempRoot());
  try {
    assert.ok(server.url.startsWith("http://127.0.0.1:"));
    assert.equal(await rawStatus(server, "/../../../../etc/hosts"), 403);
  } finally {
    await server.close();
  }
});

test("static server rejects a non-loopback Host header (DNS-rebinding defense)", async () => {
  const server = await startStaticServer(tempRoot());
  try {
    // A rebinding page (attacker.com -> 127.0.0.1) carries its own hostname in Host; refuse it.
    assert.equal(await rawStatus(server, "/secret.txt", "attacker.example"), 403);
    // The controlled browser always reaches the server as loopback, which stays served.
    assert.equal(await rawStatus(server, "/secret.txt", "127.0.0.1"), 200);
    assert.equal(await rawStatus(server, "/secret.txt", "localhost:1234"), 200);
  } finally {
    await server.close();
  }
});
