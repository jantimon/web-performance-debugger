import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { docLinksEpilog, docPaths, packageRootFrom } from "../../dist/doc-links.js";

// packageRootFrom takes a compiled dist file's URL and returns the package root one level above
// dist/, the same derivation version.ts uses. A global install, a local node_modules, and a repo
// checkout all keep this dist/<file> shape, so one rule serves all three
test("packageRootFrom resolves the parent of dist/", () => {
  const distFileUrl = pathToFileURL("/some/where/pkg/dist/cli.js").href;
  assert.equal(packageRootFrom(distFileUrl), path.join("/some/where/pkg"));
});

test("docPaths names AGENTS.md and README.md at the package root", () => {
  const root = "/opt/pkg";
  assert.deepEqual(docPaths(root), {
    agents: path.join(root, "AGENTS.md"),
    readme: path.join(root, "README.md"),
  });
});

// The epilog prints a line only for a file that exists, so a stripped install shows no dead path
// The compiled dist lives under the real package root, whose AGENTS.md/README.md both exist, so the
// live module's own URL yields both absolute lines
test("docLinksEpilog prints the absolute paths that exist", () => {
  const selfUrl = new URL("../../dist/doc-links.js", import.meta.url).href;
  const epilog = docLinksEpilog(selfUrl);
  const root = packageRootFrom(selfUrl);
  assert.match(epilog, /Docs for agents: /);
  assert.match(epilog, /Full reference: /);
  assert.ok(epilog.includes(path.join(root, "AGENTS.md")));
  assert.ok(epilog.includes(path.join(root, "README.md")));
});

test("docLinksEpilog is empty when neither doc exists", () => {
  const missingRootUrl = pathToFileURL("/no/such/pkg/dist/cli.js").href;
  assert.equal(docLinksEpilog(missingRootUrl), "");
});
