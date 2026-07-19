# symptom-bar.tape  -  routing-section shot: the reconciling breakdown bar (see README.md here).
# Renders shots/reconciling-bar.png. Run:  cd examples/demo-gif && vhs symptom-bar.tape
# WPD_DIR is derived from this tape's location, so no per-machine edit is needed.

Output symptom-bar.gif

Set Shell "bash"
Set FontSize 18
Set Width 1380
Set Height 486
Set Padding 24
Set Theme "Dracula"
Set TypingSpeed 45ms

# Hidden setup: a short `wpd`, cwd at the repo root (so examples/ resolve and --bench can serve
# the module), and the recording this shot reads. The record is not the story; the bar is.
Hide
Type 'WPD_DIR="$(cd ../.. && pwd)"' Enter
Type 'wpd() { node "$WPD_DIR/dist/cli.js" "$@"; }' Enter
Type 'cd "$WPD_DIR"' Enter
Type 'wpd record examples/measure-span.mjs --bench --breakdown --iterations 5' Enter
Sleep 12s
Type 'clear' Enter
Show

Type "wpd query spans latest --label run" Enter
Sleep 3s
Screenshot "shots/reconciling-bar.png"
