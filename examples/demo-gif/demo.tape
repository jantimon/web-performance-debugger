# demo.tape  —  source for the README hero GIF (see README.md in this folder).
# Regenerate with:  cd examples/demo-gif && vhs demo.tape
#
# Edit the two absolute paths in the Hide block for your machine.

Output demo.gif

Set Shell "bash"
Set FontSize 18
Set Width 1580
Set Height 800
Set Padding 24
Set Theme "Dracula"
Set TypingSpeed 45ms

# --- hidden setup: a short `wpd`, a clean work dir, the pre-compiled bundle as demo.mjs ---
# (next-yak/tailwind cases are compile-time; we reuse the benchmark's already-compiled
#  bundle, never re-esbuild the raw .tsx.)
Hide
Type 'WPD_DIR=/Users/jannicklas/Desktop/chrome-dev-performance-tools' Enter
Type 'BENCH=/Users/jannicklas/Development/github/next-yak/yak-worktree-2/benchmarks' Enter
Type 'wpd() { node "$WPD_DIR/dist/cli.js" "$@"; }' Enter
Type 'mkdir -p /tmp/wpd-demo && cd /tmp/wpd-demo' Enter
Type 'BUNDLE="$BENCH/bench/tailwind/data/attribution-work/bundles/btn-variant.twmerge.mjs"' Enter
Type 'cp "$BUNDLE" demo.mjs && cp "$BUNDLE.map" demo.mjs.map 2>/dev/null' Enter
Type 'clear' Enter
Show

# --- visible: the two-command story ---
Type "wpd record demo.mjs --target node --iterations 80" Enter
Sleep 9s          # record runs fast (V8 sampling pass); hold long on its summary + quick rollup.
                  # VHS does NOT wait for the process, so this must outlast it; bump if needed.

# clear the record output (hidden, so "clear" isn't shown) → final frame focuses on the query result
Hide
Type "clear" Enter
Show

Type "wpd query cpu latest --top 5" Enter
Sleep 7s          # PAYOFF: react-dom vs tailwind-merge vs your component, source-attributed.
                  # the longest, most important hold.

Sleep 1s
