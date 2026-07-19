# symptom-cpu.tape  -  routing-section shot: the node CPU rollup (see README.md here).
# Renders shots/cpu-rollup.png. Run:  cd examples/demo-gif && vhs symptom-cpu.tape
# Runs examples/ssr-demo (JSX-free, npm-installs itself). NODE_ENV=production is load-bearing:
# without it react outranks react-dom and the profile shows a cost nobody ships.

Output symptom-cpu.gif

Set Shell "bash"
Set FontSize 18
Set Width 1120
Set Height 548
Set Padding 24
Set Theme "Dracula"
Set TypingSpeed 45ms

Hide
Type 'WPD_DIR="$(cd ../.. && pwd)"' Enter
Type 'wpd() { node "$WPD_DIR/dist/cli.js" "$@"; }' Enter
Type 'cd "$WPD_DIR"' Enter
Type '(cd examples/ssr-demo && npm install --silent)' Enter
Sleep 10s
Type 'export NODE_ENV=production' Enter
Type 'wpd record examples/ssr-demo/demo.mjs --target node --iterations 250' Enter
Sleep 24s
Type 'clear' Enter
Show

Type "wpd query cpu latest --by function --top 1" Enter
Sleep 4s
Screenshot "shots/cpu-rollup.png"
