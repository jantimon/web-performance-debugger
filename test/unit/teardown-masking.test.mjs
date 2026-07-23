import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recordNode } from "../../dist/runtime/node.js";

// B-10: when the user's flow throws AND a teardown step (the cleanup hook) also throws, the primary
// run error must be the one that surfaces so the caller debugs their workload, not teardown. The
// teardown failure is attached as `cause`, never substituted. The --target node lane runs run() +
// cleanup() in-process (no browser), so a dual failure is reproducible and fast here.
const badModule = path.join(
  fileURLToPath(new URL("../..", import.meta.url)),
  "test",
  "fixtures",
  "throws-in-run-and-cleanup.mjs",
);

test("run() and cleanup() both throwing: the run error is reported, cleanup is the cause", async () => {
  await assert.rejects(
    recordNode({
      module: badModule,
      fn: "run",
      iterations: 1,
      warmup: 0,
      format: "json",
    }),
    (error) => {
      assert.match(error.message, /RUN_BOOM/, "the run failure is the one reported");
      assert.ok(!/CLEANUP_BOOM/.test(error.message), "the cleanup failure did not replace it");
      assert.match(error.cause?.message ?? "", /CLEANUP_BOOM/, "the cleanup failure is the cause");
      return true;
    },
  );
});
