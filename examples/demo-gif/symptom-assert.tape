# symptom-assert.tape  -  routing-section shot: a failing CI budget gate (see README.md here).
# Renders shots/regression-gate.png. Run:  cd examples/demo-gif && vhs symptom-assert.tape

Output symptom-assert.gif

Set Shell "bash"
Set FontSize 18
Set Width 760
Set Height 360
Set Padding 24
Set Theme "Dracula"
Set TypingSpeed 45ms

Hide
Type 'WPD_DIR="$(cd ../.. && pwd)"' Enter
Type 'wpd() { node "$WPD_DIR/dist/cli.js" "$@"; }' Enter
Type 'cd "$WPD_DIR"' Enter
Type 'wpd record examples/forces-layout.mjs --bench --deep --iterations 5' Enter
Sleep 26s
Type 'clear' Enter
Show

Type "wpd assert latest --max-forced 0 --max-layouts 50" Enter
Sleep 4s
Screenshot "shots/regression-gate.png"
