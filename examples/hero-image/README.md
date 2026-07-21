# README hero illustration

Source for the hand-drawn intro illustration near the top of the project README: a browser window,
an arrow to a terminal running `wpd record --breakdown`, an arrow to the reconciling stacked bar of
`style · layout · js · other` slices, captioned `Σ slices + idle = wall`.

The image is **generated** (ChatGPT image generation) and **not committed**: like `demo.gif`, it is
hosted on GitHub via a user-attachments URL referenced from the README, which keeps it out of the
npm tarball.

## Regenerate

Feed this prompt to ChatGPT image generation. Re-roll for an empty, minimal browser and a single
bar if the model bloats the window with fake page content or invents extra chart axes.

> A wide banner illustration, 2:1 aspect ratio, on a light off-white paper background. Three elements
> arranged left to right with a clear reading flow. On the left, a small, simple flat-drawn Chrome
> browser window (just the tab bar, three dots, an address line — no real page content). In the
> middle, a small terminal window showing one monospace line: `wpd record --breakdown`. On the right,
> the hero: a single horizontal stacked bar, hand-drawn in ink like an engineer's notebook sketch,
> divided into labelled segments sized roughly `style 43%`, `layout 23%`, `js 27%`, `other 7%`, each
> segment a distinct muted color (dusty blue, ochre, sage, warm grey). Thin hand-drawn arrows connect
> browser → terminal → bar. One handwritten annotation under the bar reads `Σ slices + idle = wall`.
> Style: clean flat UI shapes overlaid with loose pencil/ink annotation. Muted palette. Render text
> minimally and legibly using only the slice words and the one tagline; if text degrades, prefer
> fewer labels. Avoid photorealism, glossy 3D, dashboards, score rings, clutter, and fake numbers.

## Optimize

Quantize the export to a 64-color palette. On this flat-sketch style it is visually lossless and
cuts the file to about an eighth (719 KB to 92 KB):

```bash
npx sharp-cli --input intro.png --output intro-q64.png --format png --palette true --colors 64
```

## Publish

Drag `intro-q64.png` into a GitHub issue/PR comment to get a `https://github.com/user-attachments/...`
URL, then paste it into the hero `<img src>` near the top of the project README.

## Target logos

Three small hand-drawn logos (Chrome, Firefox, Node.js) mark the supported targets: a centered row
under the intro sentence and a tiny inline icon at each capture-mode table. Same sketch style and
hosting as the hero, but transparent so they sit on any background. They are stylized renditions of
third-party trademarks, shown to name the targets `wpd` supports.

Generate one strip with ChatGPT image generation:

> Three hand-drawn logos in a row, evenly spaced: the Chrome logo, the Firefox logo, and the Node.js
> logo, each drawn in loose pencil and ink in the same flat sketch style and muted palette as the
> hero, like an engineer's notebook. No text labels, no gradients, no photorealism.

Slice the OPAQUE strip into three PNGs with sharp: extract each third, key the paper background to
transparent with a border-connected flood fill (only pixels reachable from the edges within a small
color distance of the paper; interior whites like Chrome's ring survive), alpha-trim, square-pad,
resize to 240px, and quantize to a 128-color palette (~11 KB each). Do not key via a transparent
re-export from the image model: it eats the dark outline extremes (hexagon vertices, flame tips).
Publish each the same way as the hero and paste the three URLs into the logo row and the two table
lead-ins in the project README.
