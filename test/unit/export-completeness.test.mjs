import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";

// Export-completeness guard for the public surface (src/index.ts -> dist/index.d.ts). The AGENTS.md
// promise is "import them, do not hand-roll": every type NAMED inside an exported type declaration
// must itself be exported from the package root, so a consumer typing any field reaches the field's
// type by name instead of copying its shape. tsc erases types at runtime, so this walks the EMITTED
// declarations with the TypeScript compiler API: it resolves every type reference reachable from a
// root export and fails if any reference that resolves to one of OUR OWN declarations is not itself a
// root export. A dropped or forgotten re-export is caught here, not by a consumer's red build.
//
// Design (why a compiler-API walk, not a regex or a hand-maintained list): the set of transitively
// referenced types drifts as the shapes evolve, so a hardcoded list rots. The checker resolves each
// reference to its declaration symbol, which distinguishes our types (under dist/) from lib/global
// types (Record, Partial, node_modules) and from type parameters, with no dependency beyond the
// TypeScript already used to build. The walk is a worklist over declaration symbols (visited-guarded),
// so one run reports the COMPLETE set of missing exports, not just the first hop.

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(here, "..", "..", "dist");
const entry = path.join(distDir, "index.d.ts");

/** Is this symbol declared in OUR built output (dist/), as opposed to a lib/global or node_modules
 * type? lib.d.ts and installed packages live under node_modules, so a dist/ path that is not inside
 * node_modules is ours. */
function isOwnType(symbol) {
  const declarations = symbol.declarations ?? [];
  return declarations.some((declaration) => {
    const fileName = declaration.getSourceFile().fileName;
    return fileName.startsWith(distDir) && !fileName.includes("node_modules");
  });
}

/** Does this symbol declare a TYPE (interface / type alias / enum / class), the thing the promise
 * covers? A value-only export (a const, a function) is not part of the type surface. */
function declaresType(symbol) {
  const declarations = symbol.declarations ?? [];
  return declarations.some(
    (declaration) =>
      ts.isInterfaceDeclaration(declaration) ||
      ts.isTypeAliasDeclaration(declaration) ||
      ts.isEnumDeclaration(declaration) ||
      ts.isClassDeclaration(declaration),
  );
}

/** Resolve a symbol through re-export aliases to the symbol that actually declares the type. */
function resolveAlias(checker, symbol) {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

/** Collect every type-reference entity name and heritage expression under a declaration node. */
function collectReferencedNames(node, out) {
  if (ts.isTypeReferenceNode(node)) out.push(node.typeName);
  else if (ts.isExpressionWithTypeArguments(node)) out.push(node.expression);
  ts.forEachChild(node, (child) => collectReferencedNames(child, out));
}

/** The rightmost identifier of a possibly-qualified entity name (`A.B` -> `B`). */
function rightmostName(entityName) {
  return ts.isQualifiedName(entityName) ? entityName.right : entityName;
}

test("every type referenced by a public export is itself exported from the package root", () => {
  const program = ts.createProgram([entry], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    skipLibCheck: true,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const indexFile = program.getSourceFile(entry);
  assert.ok(indexFile, "dist/index.d.ts not found -- run `npm run build` before the unit suite");

  const moduleSymbol = checker.getSymbolAtLocation(indexFile);
  assert.ok(moduleSymbol, "index.d.ts has no module symbol");

  // The root exports, resolved through their re-export aliases to the real declaration symbols.
  const exportedSymbols = checker.getExportsOfModule(moduleSymbol);
  const exportedTargets = new Set();
  const exportedNames = new Set();
  for (const exportedSymbol of exportedSymbols) {
    exportedNames.add(exportedSymbol.name);
    exportedTargets.add(resolveAlias(checker, exportedSymbol));
  }
  assert.ok(exportedNames.size >= 40, `expected the full public surface, saw ${exportedNames.size}`);

  // Worklist over every reachable OWN type declaration, starting from the exported types. Each missing
  // reference is recorded once (by name); traversal continues through it so one run is complete.
  const worklist = [...exportedTargets].filter(declaresType);
  const visited = new Set(worklist);
  const missing = new Map();

  while (worklist.length > 0) {
    const symbol = worklist.pop();
    for (const declaration of symbol.declarations ?? []) {
      const referenced = [];
      collectReferencedNames(declaration, referenced);
      for (const entityName of referenced) {
        const nameNode = rightmostName(entityName);
        const referencedSymbol = checker.getSymbolAtLocation(nameNode);
        if (!referencedSymbol) continue;
        if (referencedSymbol.flags & ts.SymbolFlags.TypeParameter) continue;
        const target = resolveAlias(checker, referencedSymbol);
        if (!isOwnType(target) || !declaresType(target)) continue;
        if (!exportedTargets.has(target) && !missing.has(target.name)) {
          const home = path.relative(distDir, target.declarations[0].getSourceFile().fileName);
          missing.set(target.name, `${target.name} (declared in dist/${home})`);
        }
        if (!visited.has(target)) {
          visited.add(target);
          worklist.push(target);
        }
      }
    }
  }

  assert.deepEqual(
    [...missing.values()].sort(),
    [],
    "public types reference these types by name but the package root does not export them; " +
      "re-export each from src/index.ts (import them, do not hand-roll)",
  );
});
