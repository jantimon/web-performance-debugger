# The orchestrator boundary: what wpd leaves to the caller, and why (internal)

> **Developer notes, not user documentation.** Read the [README](../../README.md) to use wpd. This
> file states what wpd deliberately does not do, so a feature request can be answered with a link
> instead of an argument. It is the standing scope decision, not a wishlist.

Related: [core-features.md](./core-features.md) (what wpd does do, and where the field stands). The
README's [capture-mode section](../../README.md#one-capture-per-run-the-capture-modes) holds the
run-group case the third test below turns on.

**In this file**

- [What wpd is, and what it is not](#what-wpd-is-and-what-it-is-not)
- [The lean-surface test](#the-lean-surface-test)
- [What the orchestrator owns](#what-the-orchestrator-owns)
- [What wpd owes in exchange](#what-wpd-owes-in-exchange)

**Provenance.** The evidence here is maintainer scope decisions, not engine probes: choices already
applied in practice (2026-07-20/21) — the third-party classification flag and the
doctor/init/compare/HTML-report asks that all stay out. Stated below as present-tense scope.

## What wpd is, and what it is not

wpd is a precision measurement instrument for professionals and the orchestrators working for them:
an agent, a CI script, or the person at the terminal. It **finds and investigates** — it names the
line that forced the layout, the package that owns the milliseconds, the count that reproduces. It
**does not grade, rank, or guide.**

So it is not a compare library, not a comparison-website engine, not Lighthouse. Those tools score a
site against a rubric and tell you what to do next. wpd hands you exact, provenance-stamped numbers
and the JSON to act on them. The judgment — is this good, is it better, what should change — belongs
to the caller, who holds context wpd does not.

## The lean-surface test

Every proposed feature passes three questions before it earns a flag:

1. **Is the fact already derivable from existing output through the JSON contract?** Then the
   orchestrator derives it. No new flag ships to re-expose data the artifact already carries.
2. **Is it measurement, or is it judgment?** Measurement and attribution are facts, and facts ship.
   Judgment and synthesis are editorial, and editorial never ships from the tool.
3. **Does it remove bookkeeping wpd itself created?** That is the strongest case for building it. Run
   groups exist because the one-capture-per-run split is wpd's own constraint, so wpd owns the
   manifest that stitches the members back together.

Correctness and honesty fixes to existing surface are never "features" under this test.
An n/a-FAIL that should have fired, a fake zero, a broken provenance stamp: those are defects, and a
defect outranks any feature on this page.

## What the orchestrator owns

Each of these stays out of wpd for a stated reason, not by neglect.

- **Question-to-command mapping** (doctor, init, intent flags, recommenders). Picking the command for
  a situation is judgment about the user's situation. The README maps symptoms to commands as
  documentation; anything smarter is the orchestrator reading that same table.
- **Environment preflight.** The orchestrator owns its environment. wpd owes a precise failure
  message when something it needs is missing — and delivers one — not a product that diagnoses the
  machine.
- **Flow scaffolding and templates.** A driver module is the orchestrator's code about its own app.
  wpd owes a small, stable `run` contract for it, not a generator that writes it.
- **Site-interaction mechanics** (consent dialogs, logins, bot-interstitial clicks). This is workload
  authorship, the same boundary as scaffolding: the orchestrator writes what its app needs driven.
- **N-way and cross-site comparison, scorecards, reports** (including HTML rendering). Comparing
  different workloads needs judgment about what is comparable, which is why wpd refuses to gate across
  workloads at all. An "advisory" comparison view would present that judgment as measurement and
  read as a verdict wpd cannot defend. The three-shop dogfood is the proof: an orchestrator
  built a defensible comparison on wpd's JSON in an afternoon, supplying the human-grade
  comparability judgment wpd could not.
- **Classification lists** (trackers, first-party vs third-party editorial). Origin buckets are facts
  wpd already emits. "This origin is a tracker" is editorial the orchestrator brings.
- **Cross-run and cross-version baseline management** beyond the honest schema-epoch gate. Where
  baselines live and how long they are kept is storage policy the orchestrator owns. wpd owes a
  refusal to misparse an old artifact and a stable epoch marker, nothing more.

## What wpd owes in exchange

The boundary is honest, not lazy, only because wpd holds up its side. It owes the orchestrator:

- a **typed, stable JSON/TOON contract** for every artifact and every structured output;
- **honest refusals** — an n/a-FAIL, a comparability gate — never a fake zero or fake cross-engine
  parity;
- **provenance on every number**: capture mode, member, and trust tier;
- **primitives that survive real pages**: redirects, cross-document navigations, bot protection;
- **machine-detectable failure**: a non-zero exit on every gate the orchestrator can branch on.

When this contract breaks, it is the highest-priority defect, not a feature request. Everything the
orchestrator builds stands on these guarantees, so a silent drift in the JSON shape or a swallowed
failure is worse than a missing feature: it breaks callers that were right to trust the number.
