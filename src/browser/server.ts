import http from "node:http";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";

const MIME: Record<string, string> = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".html": "text/html",
  ".css": "text/css",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".wasm": "application/wasm",
};

export interface StaticServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

/** Serve `root` over http so the browser can ESM-import() modules (file:// can't). */
export async function startStaticServer(root: string): Promise<StaticServer> {
  const absRoot = path.resolve(root);

  const server = http.createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
      // CORS so modules can be imported into a cross-origin host page (--url mode).
      res.setHeader("Access-Control-Allow-Origin", "*");

      // A same-origin blank host page so module-mode import() isn't cross-origin.
      if (urlPath === "/__wpd_blank__") {
        res.setHeader("Content-Type", "text/html");
        res.setHeader("Cache-Control", "no-store");
        return res.end(
          '<!doctype html><html><head><meta charset="utf-8"><title>wpd</title></head><body></body></html>',
        );
      }

      let filePath = path.normalize(path.join(absRoot, urlPath));
      if (filePath !== absRoot && !filePath.startsWith(absRoot + path.sep)) {
        res.statusCode = 403;
        return res.end("Forbidden");
      }
      let stat;
      try {
        stat = await fs.stat(filePath);
      } catch {
        res.statusCode = 404;
        return res.end("Not found");
      }
      if (stat.isDirectory()) {
        // Re-stat the index file: a directory without index.html must 404, not blow up
        // later when the read stream can't open it.
        filePath = path.join(filePath, "index.html");
        try {
          await fs.stat(filePath);
        } catch {
          res.statusCode = 404;
          return res.end("Not found");
        }
      }
      const ext = path.extname(filePath).toLowerCase();
      res.setHeader("Content-Type", MIME[ext] ?? "application/octet-stream");
      res.setHeader("Cache-Control", "no-store");
      const stream = createReadStream(filePath);
      // A read error fires asynchronously (after this handler returns), so the outer
      // try/catch can't see it. Without this listener it's an uncaught 'error' that
      // crashes the whole record run.
      stream.on("error", () => {
        if (!res.headersSent) res.statusCode = 500;
        res.end();
      });
      stream.pipe(res);
    } catch (err) {
      res.statusCode = 500;
      res.end(String(err));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
