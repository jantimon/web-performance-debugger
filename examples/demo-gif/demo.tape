# demo.tape  —  source for the README hero GIF (see README.md in this folder).
# Regenerate with:  cd examples/demo-gif && vhs demo.tape
#
# Edit the one absolute path in the Hide block for your machine.
#
# This used to copy a pre-compiled bundle out of a private benchmarks repo, which meant only one
# person on one machine could re-render it. It duly rotted: the bundle was deleted, and the GIF went
# on demonstrating a CLI flag that had been removed. It now runs examples/ssr-demo, which is
# committed here and needs no build step, so anyone can regenerate this.

Output demo.gif

Set Shell "bash"
Set FontSize 18
Set Width 1580
Set Height 920
Set Padding 24
Set Theme "Dracula"
Set TypingSpeed 45ms

# --- hidden setup: a short `wpd`, and the demo's own directory as cwd ---
# NODE_ENV=production is hidden rather than shown because it is not part of the story, but it IS
# load-bearing: without it React resolves to its development build, whose dev-only bookkeeping
# dominates the profile and buries the point (`react` outranks `react-dom`, and the cost you would
# be reading is not the cost you ship).
Hide
Type 'WPD_DIR=/Users/jannicklas/Desktop/web-performance-debugger' Enter
Type 'wpd() { node "$WPD_DIR/dist/cli.js" "$@"; }' Enter
Type 'cd "$WPD_DIR/examples/ssr-demo" && npm install --silent' Enter
Type 'export NODE_ENV=production' Enter
Type 'clear' Enter
Show

# --- visible: the two-command story ---
Type "wpd record demo.mjs --target node --iterations 250" Enter
Sleep 8s          # record itself takes ~1s; VHS does NOT wait for the process, so this only has to
                  # outlast it. The long hold is for reading the summary + package rollup.

# clear the record output (hidden, so "clear" isn't shown) → final frame focuses on the query result
Hide
Type "clear" Enter
Show

Type "wpd query cpu latest --top 5" Enter
Sleep 7s          # PAYOFF: react-dom vs tailwind-merge vs your component, source-attributed, with
                  # `tailwind-merge get (lib/lru-cache.ts:35)` the single hottest function.

Sleep 1s
