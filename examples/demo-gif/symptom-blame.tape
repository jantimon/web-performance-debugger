# symptom-blame.tape  -  routing-section shot: forced-layout blame (see README.md here).
# Renders shots/forced-blame.png. Run:  cd examples/demo-gif && vhs symptom-blame.tape

Output symptom-blame.gif

Set Shell "bash"
Set FontSize 18
Set Width 1160
Set Height 452
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

Type "wpd query blame latest --forced --top 1" Enter
Sleep 4s
Screenshot "shots/forced-blame.png"
