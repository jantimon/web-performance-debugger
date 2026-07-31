# AGENTS.md: what it is and why it is shaped this way

`AGENTS.md` at the repo root is a **tool-usage manual for an agent consuming the `wpd` CLI**: how to
drive `record`/`query` and how to read the typed output. It is not a contributor map -- that is
`CLAUDE.md`, which runs as long as the removal test allows (file routing plus load-bearing
constraints, with directory-local guidance pushed to nested `CLAUDE.md` files like
`examples/demo-gif/`), not by a line target. The two files answer different questions and obey
different length rules.

Evidence here is **not** engine-probed. It carries its own tiers: **[spec]** the agents.md open spec;
**[vendor-doc]** first-party agent-vendor guidance (Anthropic, GitHub); **[practitioner]** aggregated
repo analysis or hands-on write-ups; **[inferred]** reasoning from those. No published, reproducible
benchmark pins an optimal AGENTS.md length. Every length number below is either a vendor's
design-mechanism claim or a correlational read of a repo corpus. Treat the thresholds as directional.

## Why length is a correctness constraint, not taste

**Over-long instruction files make an agent silently drop rules** [vendor-doc]. As context fills,
output quality degrades and buried instructions get deprioritized; Anthropic states this as the core
constraint on CLAUDE.md and names the failure mode "bloated files cause the agent to ignore your
actual instructions." The failure is silent -- a rule quietly stops being followed, not a loud error --
so you cannot detect over-length by watching for crashes. The governing test is one question per line:
**would removing this cause the agent to make a mistake?** If not, cut it.

Community length numbers converge but rest on one self-selected corpus (GitHub's 2,500+ repo
analysis) with no reproducible dataset [practitioner]: a 40-80 line sweet spot, ~100 lines a
reasonable ceiling; a well-performing file runs ~300-350 words, returns diminish past ~500, and past
~1000 words the correlation with agent performance goes negative. Directional, not law -- but they
point one way, and the dilution mechanism is the reason.

## The two highest-value shapes

- **Commands first** [practitioner]. Put the executable commands, with flags, in an early section;
  do not bury them in prose. One real snippet beats three paragraphs describing it.
- **Explicit boundaries** [practitioner]. The single most-cited helpful constraint across the corpus
  is a hard "never" (the canonical example is "never commit secrets"). An always / ask-first / never
  shape carries more signal per token than any amount of description.

For wpd this lands as the `record -> query` drill block up top, the `Never read the recording file
directly` rule, and the refusal boundaries (`the refusal text is the answer`).

## Delegation is what licenses brevity

Reference material -- a field-by-field type table, a full flag list -- is **"detailed API
documentation": link it, never inline it** [vendor-doc, exclude-list]. Inlining it duplicates the
authoritative source (the README's `#consuming-the-json` table and the exported view types) and spends
always-loaded budget on lookup an agent should do on demand. The pointer block at the foot of AGENTS.md
is therefore not filler: it is the mechanism that lets the body stay short. **Do not shorten by
deleting pointers; shorten by moving inlined reference behind them** [spec endorses nesting/pointers;
the llms.txt manifest pattern is the same shape].

## Read on demand in a consumer repo, auto-loaded only here [inferred]

Shipped inside the npm package, this file lands at
`node_modules/@jantimon/web-performance-debugger/AGENTS.md`. Agents do not auto-load `node_modules`, so
in a *consumer* repo it is read **on demand** -- when the agent is told to use wpd -- not injected on
every request. That weakens the always-loaded token-budget argument there: an on-demand manual can run
a little longer than an always-loaded root file before length bites. The penalty is sharpest in
**this** repo, where the file sits at the root as the auto-loaded AGENTS.md and competes with the large
`CLAUDE.md` for the always-loaded budget while spending it entirely on tool *consumption*, not
development. So the file stays lean for this repo's sake even though a consumer could tolerate more.

## The keep-list: lines that earn their place

These survive any "make it shorter" pass because removing them would cause a mistake:

- **`Never read the recording file directly -- it can be many MB.`** The highest-ROI line: it stops an
  agent dumping a multi-MB artifact into context. A non-obvious behavior the agent cannot infer from
  code it cannot see.
- **`null` is not `0`, and a gate on an unmeasured metric is a loud `n/a` FAIL.** A silent-wrong-math
  footgun: coercing not-measured to `0` fabricates a "measured clean" signal. Kept with one concrete
  example (`assert --max-forced 0` on `--breakdown`).
- **`The refusal text is the answer -- do not retry to force a number.`** Stops an agent looping
  against an intentional refusal.
- **The scope boundary** (`finds and investigates; does not grade, rank, or recommend`). One sentence
  that reframes the interaction and stops the agent asking wpd for a judgment it does not emit.
- **The pointer block.** Keeping it is the brevity strategy, per the delegation rule above.

## The standing constraint on additions

Every line added to AGENTS.md must pass the **would-removing-this-cause-mistakes** test, and **prefer a
pointer to a README anchor over inlined reference**. A field name, a flag table, or an explanation the
agent can read on demand from an authoritative place does not belong in the always-considered body. If
a genuinely non-obvious behavior has no home elsewhere, add the behavior -- not its documentation --
and point to the depth.
