# README demo GIF

Source for the animated GIF at the top of the project README. The GIF shows the `--runtime node`
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

- Edit the two absolute paths (`WPD_DIR`, `BENCH`) in the `Hide` block of `demo.tape` for your
  machine.
- The tape records against the next-yak benchmark's **pre-compiled** bundle
  (`btn-variant.twmerge.mjs`). Use the compiled bundle, never raw `.tsx` (tailwind/next-yak cases
  are compile-time). If it's missing, run `pnpm bench:tw:attribution` in the benchmark project.

Color is automatic: VHS records in a real TTY, so the output is colorized exactly as a user sees it
in their terminal (heat-colored `self %`, dimmed paths, bold headline). No flag needed.

## Publish

Drag `demo.gif` into a GitHub issue/PR comment to get a `https://github.com/user-attachments/...`
URL, then paste it into the `<img src>` near the top of the project README.
