---
"@jantimon/web-performance-debugger": minor
---

**Changed: the `latest` pointer no longer writes a `recordings/` dir into your cwd.** It is now
cwd-keyed and stored under `$XDG_STATE_HOME/wpd/pointers/` (falling back to `~/.local/state/wpd/`),
so recording with `--out` elsewhere leaves the working tree untouched. `latest` still resolves from
the cwd you recorded in, and an in-flight `recordings/.wpd-last.json` left by an older run is still
read as a fallback.

**Docs: pnpm install recipe.** pnpm 10+ blocks Puppeteer's browser-download postinstall (pnpm 11
hard-fails `pnpm exec wpd`); the README now documents the `onlyBuiltDependencies` /
`ignoredBuiltDependencies` recipes.

**Changed: `query cpu` states the iteration divisor** in its header when `--iterations > 1` (the
JS self-time headline is a whole-window total; divide by N for a per-iteration figure).
