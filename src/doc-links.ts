import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The installed package root, derived from a compiled dist file's URL. dist/ sits one level under
 * the package root in this repo and in the published tarball, so the parent of dist/ is the root.
 * Same derivation version.ts uses to reach package.json, so a global, a local node_modules, and a
 * repo checkout all resolve correctly without a hardcoded path.
 */
export function packageRootFrom(moduleUrl: string): string {
  return path.dirname(path.dirname(fileURLToPath(moduleUrl)));
}

/** Absolute paths to the two docs an agent reads: AGENTS.md (tool-usage manual), README.md (full reference). */
export function docPaths(packageRoot: string): { agents: string; readme: string } {
  return {
    agents: path.join(packageRoot, "AGENTS.md"),
    readme: path.join(packageRoot, "README.md"),
  };
}

/**
 * The --help footer naming where to read more, as ABSOLUTE paths so an agent can open the file on
 * this machine. The absolute path is deliberate: displayPath's home-dir privacy rule guards pasted
 * reports, not --help on the caller's own terminal. Each line prints only if its file exists, so a
 * stripped install never shows a dead path.
 */
export function docLinksEpilog(moduleUrl: string): string {
  const { agents, readme } = docPaths(packageRootFrom(moduleUrl));
  const lines: string[] = [];
  if (existsSync(agents)) lines.push(`Docs for agents: ${agents}`);
  if (existsSync(readme)) lines.push(`Full reference:  ${readme}`);
  return lines.length === 0 ? "" : `\n${lines.join("\n")}\n`;
}
