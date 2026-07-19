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

## Routing-section shots (`shots/`)

The README's "Start from your symptom" section pairs each entry with a static terminal shot of the
real command's output. Those PNGs live in `shots/` and, unlike `demo.gif`, are **committed**: they
render inline on GitHub, and npm rewrites the repo-relative `<img>` paths through the `repository`
field, so they show on npmjs.com too. They are not in the npm tarball (`files` ships only
`dist`/`README`/`LICENSE`), so committing them does not bloat the package.

One tape per shot, each driving the real CLI against a committed example so it reproduces from a
clean checkout:

| Tape | Shot | Command |
| --- | --- | --- |
| `symptom-bar.tape` | `shots/reconciling-bar.png` | `query spans --label run` on a `--breakdown` recording of `examples/measure-span.mjs` |
| `symptom-blame.tape` | `shots/forced-blame.png` | `query blame --forced --top 1` on a `--deep` recording of `examples/forces-layout.mjs` |
| `symptom-cpu.tape` | `shots/cpu-rollup.png` | `query cpu --by function --top 1` on a `--target node` recording of `examples/ssr-demo/demo.mjs` |
| `symptom-assert.tape` | `shots/regression-gate.png` | `assert --max-forced 0 --max-layouts 50` failing on the `--deep` forced-layout recording |

Regenerate one (or all) from this directory:

```bash
npm run build                          # from the repo root; the tapes run dist/cli.js
cd examples/demo-gif
vhs symptom-bar.tape                    # writes shots/reconciling-bar.png (+ a git-ignored .gif)
```

No per-machine edit: each tape derives the repo root from its own location
(`WPD_DIR="$(cd ../.. && pwd)"`, since VHS runs from the tape's directory), then `cd`s there so
`--bench`/`--target node` can serve and import the example. The record step is hidden; the shown
frame is the query/assert result alone.

Tape gotchas specific to the shots:

- **`Screenshot`/`Output` paths containing a `/` must be quoted** (`Screenshot "shots/x.png"`);
  an unquoted path with a slash is a parse error, while a bare filename (`Output demo.gif`) works
  unquoted. Both are written relative to VHS's launch directory (`examples/demo-gif`), not the
  shell's `cd`.
- **`Set Width`/`Set Height` are top-of-file only** (VHS ignores them mid-tape). That is why there
  is one tape per shot: each is sized to frame its own output tightly (crop by terminal size, not by
  editing the PNG). Height must fit the whole output including the typed command line; if it is too
  short the terminal scrolls and the command line is lost off the top.
- **The record `Sleep` must comfortably outlast the process.** VHS fires the next keystroke and the
  screenshot on wall-clock, not on process exit, so a too-short sleep screenshots a half-finished
  record, and VHS then writes no file at all. The chrome `--deep` records need ~26s under VHS.
- **Color is automatic** (real PTY), and **`NODE_ENV=production` is load-bearing** for the node CPU
  shot, for the same reasons as the hero GIF above.

Shots are kept well under a few hundred KB each by framing tightly and showing one focused result
(a `--top 1` where the full table would sprawl); prefer fewer good shots over a wide, unreadable one.
