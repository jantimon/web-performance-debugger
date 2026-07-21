// Packaged-artifact smoke: build the tarball exactly as `npm publish` would, install it into a
// throwaway consumer project, and prove the PUBLISHED surface works end to end -- the bin runs, a
// real `--target node` record writes an artifact, and the documented root types compile against the
// installed package. This catches what a test against the repo's own dist/ cannot: a missing file in
// the `files` list, a broken bin field, or a type export that dropped out of the package root.
//
// Browser-free and fast, so it rides every CI run. Run it locally with `node scripts/pack-smoke.mjs`.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const packageName = "@jantimon/web-performance-debugger";

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: "inherit", ...options });
}
function capture(command, args, options = {}) {
  // Capture stdout (the return value) but let stderr through to the parent, so a failing command's
  // diagnostics land in the CI log instead of being swallowed into the thrown error's .stderr.
  return execFileSync(command, args, { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"], ...options });
}

// Build + pack from the repo. `npm pack` honors the `files` list, so the tarball is byte-identical
// to what `npm publish` uploads; its last stdout line is the tarball filename.
run("npm", ["run", "build"], { cwd: root });
const tarball = path.join(
  root,
  capture("npm", ["pack", "--silent"], { cwd: root }).trim().split("\n").pop().trim(),
);
if (!existsSync(tarball)) throw new Error(`npm pack did not produce a tarball (looked for ${tarball})`);
console.log(`packed ${path.basename(tarball)}`);

const work = mkdtempSync(path.join(tmpdir(), "wpd-pack-smoke-"));
const cleanup = () => rmSync(work, { recursive: true, force: true });
try {
  // A fresh consumer project that installs ONLY the tarball (plus tsc for the type check), so we
  // exercise real dependency resolution, not the repo's node_modules.
  writeFileSync(
    path.join(work, "package.json"),
    JSON.stringify(
      { name: "wpd-pack-smoke-fixture", version: "0.0.0", private: true, type: "module" },
      null,
      2,
    ),
  );
  // puppeteer is a runtime dependency, so its postinstall would fetch Chrome; skip that here so the
  // smoke stays browser-free whatever the caller's environment (CI sets this at the job level too).
  run("npm", ["install", "--no-audit", "--no-fund", "--no-save", tarball, "typescript@6"], {
    cwd: work,
    env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: "true" },
  });

  // The bin resolves and runs. Going through node_modules/.bin/wpd exercises the bin wiring itself,
  // so a broken bin field or a missing shebang fails here.
  const bin = path.join(work, "node_modules", ".bin", "wpd");
  const version = capture(bin, ["--version"], { cwd: work }).trim();
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`wpd --version printed ${JSON.stringify(version)}`);
  console.log(`wpd --version -> ${version}`);

  // A real `--target node` record against a tiny fixture module: CPU-only lane, no browser.
  const probeModule = path.join(work, "probe.mjs");
  writeFileSync(
    probeModule,
    "export function run() {\n" +
      "  let total = 0;\n" +
      "  for (let index = 0; index < 200000; index++) total += Math.sqrt(index);\n" +
      "  return total;\n" +
      "}\n",
  );
  const out = path.join(work, "probe.json");
  run(bin, ["record", probeModule, "--target", "node", "--iterations", "3", "--out", out], {
    cwd: work,
  });
  if (!existsSync(out)) throw new Error("record --target node did not write the artifact");
  // The CPU model is a sibling with the base extension swapped for `.cpu.json` (probe.json -> probe.cpu.json).
  const cpuModel = out.replace(/\.json$/, ".cpu.json");
  if (!existsSync(cpuModel)) throw new Error("record --target node did not write the CPU model");
  const recording = JSON.parse(readFileSync(out, "utf8"));
  if (recording.meta.runtime !== "node")
    throw new Error(`expected meta.runtime "node", got ${JSON.stringify(recording.meta.runtime)}`);
  console.log(`record --target node -> ${path.basename(out)} (runtime ${recording.meta.runtime})`);

  // The documented root types compile against the installed package. One name per line so extending
  // this list (e.g. run-group types) as they land in the export is a one-line change.
  const typeNames = [
    "Recording",
    "Span",
    "SpanKind",
    "NormalizedEvent",
    "CpuModel",
    "CpuFunction",
    "CpuEdge",
    "SpansResult",
    "SpanEntry",
    "UnifiedSlices",
    "SpanAnatomy",
    "CpuOverview",
    "FrameQueryResult",
    "BlameEntry",
    "CpuDiffResult",
    "RawCpuProfile",
    "LastPointer",
    "WaitForStableOptions",
  ];
  // A missing member in a `import type { ... }` is a hard compile error (TS2305), so listing the
  // promised types is enough to catch export drift; the value imports get a trivial reference.
  const typesProbe =
    `import type {\n${typeNames.map((name) => `  ${name},`).join("\n")}\n} from "${packageName}";\n` +
    `import { SCHEMA_VERSION, waitForStable } from "${packageName}";\n\n` +
    "const recording: Recording = JSON.parse(\"{}\");\n" +
    "const schema: string = SCHEMA_VERSION;\n" +
    "const settle: typeof waitForStable = waitForStable;\n" +
    "void recording;\n" +
    "void schema;\n" +
    "void settle;\n";
  writeFileSync(path.join(work, "types-probe.ts"), typesProbe);
  writeFileSync(
    path.join(work, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          target: "ES2022",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        files: ["types-probe.ts"],
      },
      null,
      2,
    ),
  );
  run(path.join(work, "node_modules", ".bin", "tsc"), ["--project", "tsconfig.json"], { cwd: work });
  console.log("root types compile against the installed package");

  console.log("\npack-smoke passed");
} finally {
  cleanup();
  rmSync(tarball, { force: true });
}
