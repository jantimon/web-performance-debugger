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

Two things in the tape that look incidental and are not:

- **`NODE_ENV=production`** (hidden). Without it React resolves to its development build, whose
  dev-only bookkeeping dominates the profile: `react` outranks `react-dom`, and the cost on screen
  is not the cost anyone ships.
- **Dependencies stay external** (a real `npm install`, never bundled). That is what lets wpd roll
  self-time up per package — bundle react-dom in and its cost lands in the `app` bucket.

Color is automatic: VHS records in a real TTY, so the output is colorized exactly as a user sees it
in their terminal (heat-colored `self %`, dimmed paths, bold headline). No flag needed.

## Publish

Drag `demo.gif` into a GitHub issue/PR comment to get a `https://github.com/user-attachments/...`
URL, then paste it into the `<img src>` near the top of the project README.
