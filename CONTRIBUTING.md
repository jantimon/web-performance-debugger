# Contributing

Thanks for helping. This is a measurement tool, so the bar for a change is not "does it read right"
but "did you measure it". Read the one rule below before anything else.

## The probe bar

**A claim about browser or engine behaviour needs a probe, not a mechanism.** A plausible mechanism is
not evidence. Sourcemaps, INP, Gecko cause stacks, and sampler isolation all behave in ways a
mechanism alone predicts wrongly, and the whole tool exists because the obvious answer and the
measured one differ often enough that the difference is the point.

So before you write a sentence or a line of code that asserts how an engine behaves, run the probe
(`examples/forces-layout.mjs` in both engines) and look at the output. This is what makes every number
`wpd` prints trustworthy: each load-bearing fact is reproduced locally and tagged `[measured]`
(reproduced here) or `[source]` (read from mozilla-central or chromium at tip, with a permalink). The
rule, its corollaries, and how to add a fact live in
[docs/dev/README.md](docs/dev/README.md#how-to-add-a-claim-here); the measured numbers the code
depends on are the ledger in [docs/dev/facts.md](docs/dev/facts.md), which a unit test keeps from
drifting.

`docs/dev/` is the internal map behind the non-obvious choices. Read the file that covers the code you
touch (the table at the top of [docs/dev/README.md](docs/dev/README.md) says which) before you change
a capture mode, the Gecko converter, or any cross-engine claim.

## Setup

Node 24+. Three commands:

```bash
npm ci          # install
npm run build   # tsc -> dist/ (ESM, NodeNext)
npm test        # unit tests (pretest builds first); pure functions, no browser
```

`npm test` needs no browser and finishes in seconds. Chrome is downloaded by Puppeteer on install; to
skip it, work on the `--target node` lane, whose tests are browser-free.

## The test lanes

Four lanes, run one when you touch its area:

| Lane | Command | What it does |
| --- | --- | --- |
| **unit** | `npm test` | pure functions against compiled `dist/`, no browser |
| **measurement** | `npm run test:measurement` | records a real `--target node` CPU profile, browser-free; runs serially (`--test-concurrency=1`) so a parallel worker cannot inflate a near-no-op recording |
| **chrome e2e** | `npm run test:e2e` | spawns the built CLI against real headless Chrome |
| **firefox e2e** | `npm run test:e2e:firefox` | drives the Gecko lane against real Firefox |

Each e2e lane **self-skips when its browser is absent**, so `npm test` and CI stay green without one.
The `WPD_E2E_REQUIRED=1` / `WPD_E2E_FIREFOX_REQUIRED=1` env vars (set by the e2e scripts and the CI
jobs) turn a missing browser into a hard failure, so the e2e jobs cannot silently pass.

Before you push, the gates CI runs:

```bash
npm run lint          # oxlint src
npm run format:check  # oxfmt --check
npm run knip          # dead exports/files/deps (a fresh dead export fails it)
```

## Changesets

Every change that affects a published user adds a changeset:

```bash
npm run changeset
```

A changeset is a release note read by someone deciding whether to upgrade. Say what changed, what
breaks, and what to do about it. Keep it to about **5 lines** (about **15** for a breaking change),
and lead with **Breaking:** where it applies. The reasoning (why the bug existed, what you measured,
what you ruled out) belongs in the pull request and the code comments, not the changeset. CI versions
and publishes on merge to `main`.

## Commit and branch conventions

- **No tooling attribution in commits or pull requests.** Do not add a `Co-Authored-By:` trailer, a
  "Generated with ..." line, a session link, or any similar advertisement. Write the message as the
  change itself, nothing more.
- **Describe the code as it is now.** No archeology: cut past-tense narration ("used to", "was null
  before", version or PR numbers used as rationale). Keep every `[measured]` number and the constraint
  it justifies, phrased in the present.
- **Descriptive branch names.** `docs/oss-surface`, `fix/firefox-idle-cutoff` -- not `patch-1`.
