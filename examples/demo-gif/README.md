# README demo GIF

Source for the animated GIF at the top of the project README. The GIF shows the `--target node`
CPU lane attributing SSR `renderToString` self-time to **react-dom vs the styling library
(tailwind-merge) vs your component**, each down to a source line.

`demo.tape` is the source of truth (a [VHS](https://github.com/charmbracelet/vhs) script). The
rendered `demo.gif` is **git-ignored** and not committed: it's hosted on GitHub via a
user-attachments URL referenced from the project README, which keeps it out of the npm tarball.

## Regenerate

```bash
brew install vhs ttyd ffmpeg          # one-time
npm run build                         # from the repo root; the tape runs dist/cli.js

cd examples/demo-gif && vhs demo.tape # writes demo.gif here
```

Prereqs:

- Edit the one absolute path (`WPD_DIR`) in the `Hide` block of `demo.tape` for your machine.
- Nothing else. The tape runs [`examples/ssr-demo`](../ssr-demo/), which lives in this repo and
  `npm install`s itself from the tape. It is JSX-free on purpose, so there is no build step.

That last point is the whole design. **If you change this demo, keep it runnable from a clean
checkout.** A tape that depends on an artifact only one machine can build is a tape nobody
re-renders, and a GIF nobody re-renders goes on demonstrating a CLI that no longer exists.

What it shows: `react-dom` ~49% vs `tailwind-merge` ~28% vs `wpd-ssr-demo` (your component) ~12%,
with `tailwind-merge get (lib/lru-cache.ts:35)` the single hottest function (~27%) as the punchline.
Both the `record` and `query cpu` output carry the four-slice CPU bar (`js · gc · native · idle`,
node's engine slice is `native`), and the `query cpu` headline names the per-iteration divisor. The
point is that this stays runnable from a clean checkout, not the exact percentages.

Things in the tape that look incidental and are not:

- **`NODE_ENV=production`** (hidden). Without it React resolves to its development build, whose
  dev-only bookkeeping dominates the profile: `react` outranks `react-dom`, and the cost on screen
  is not the cost anyone ships.
- **Dependencies stay external** (a real `npm install`, never bundled). That is what lets wpd roll
  self-time up per package — bundle react-dom in and its cost lands in the `app` bucket.
- **`--iterations 250`** buys sampling stability. The node lane windows the profile to the timed
  loop, so `post (node:inspector)` (the profiler warmup) reads 0 ms and never ranks. At 80 iterations
  `tailwind-merge get` already leads (~23%); 250 only tightens it (~27%). Fewer reads noisier, so keep
  it high enough that the top rows stay stable between runs.
- **`Sleep` must outlast the process.** VHS fires the next keystroke after the `Sleep`, not when the
  command exits, so the `record` step's Sleep only has to run longer than its ~1s runtime.
- **`FontSize 18` + `Width 1580`.** The widest line is the iteration-divisor headline (~188 chars),
  which soft-wraps to two rows at this width; report paths print relative to cwd (`displayPath`), so
  an absolute home path never wraps and leaks into the frame.
- A hidden `clear` wipes the `record` output before `query cpu` so the final frame is the result alone.
- The GIF (~300K) ships as-is; `gifsicle -O3` shrinks it losslessly if ever needed.

Color is automatic: VHS records in a real TTY, so `process.stdout.isTTY` is true and the default
`--color auto` colorizes exactly as a user sees it (heat-colored `self %`, cyan packages, dimmed
paths, bold headline). No flag needed.

## Publish

Drag `demo.gif` into a GitHub issue/PR comment to get a `https://github.com/user-attachments/...`
URL, then paste it into the `<img src>` near the top of the project README.
