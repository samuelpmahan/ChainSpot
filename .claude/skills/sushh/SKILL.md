---
name: sushh
description: >
  Sprint Using SHH — for a goal bigger than a single feature but still one
  coherent initiative (several feature-sized chunks, real dependencies
  between them). Front-loads contracts/interfaces into one mise-en-place
  sprint layout, gets explicit sign-off, then runs chunks through `shh` in
  parallel waves, gated by an explicit human go/no-go after every wave.
  Not for one feature (too small) or unrelated tickets (backlog triage).
---

# Sushh (Sprint Using SHH)

## Mise-en-place at every step is the alignment mechanism — not overhead

You will not want to stop. Every instinct this pipeline runs on —
parallelism, momentum, cheap generation — pushes toward launching the next
thing, and pausing for a mise-en-place layout feels like friction against
the whole point. It isn't. Each MEP the human explicitly approves is
in-context learning in the most literal sense: the approved layout sits in
every worker's context as ground truth about what the human actually
wants, before a single line gets generated. That is alignment doing what
the word literally means — "alignment alignment" — every agent in the
sprint pointed the same direction as the human, checked at the exact
moment correction is cheapest. A sprint that skips MEPs isn't a faster
version of the same process; it's a different process, one where each
agent reconstructs intent from a compressed one-liner, drifts in its own
direction, and the drift only surfaces at integration, where it costs the
most. And this cuts hardest exactly where skipping feels most justified: a
small change is a tiny vector, and you cannot gauge the alignment of a
tiny vector — there's almost no length to read a direction from. A long,
laid-out piece of work shows its direction plainly; a "trivial" change
shows almost nothing, which is why "too small to need an MEP" is exactly
backwards. The smaller the step, the more the explicit layout-and-go is
the only alignment signal that exists at all.

Every one of these is its own stop with its own explicit go — none
pre-approved by an earlier one:

1. Phase 1's sprint layout (contracts, chunks, waves) — explicit go before
   any wave launches.
2. **Each chunk's `shh` pretask MEP, every wave.** Phase 1 sign-off does
   NOT pre-approve these. Being pre-filled from Phase 1's contracts makes
   a chunk MEP fast to review — never skippable.
3. Phase 3's post-wave go/no-go — explicit, before the next wave starts.

Silence, momentum, "the sprint plan already covered this," and "it's just
a small chunk" are all no-gos. If work is about to launch and the human
hasn't explicitly approved its MEP in this conversation, that is the exact
failure this section exists to stop.

Maximize parallelism *across chunks in a wave* by front-loading the hard
thinking into Phase 1 instead of leaving each chunk's lead to rediscover it.
Most token spend should land in cheap `shh` generation, not expensive
re-derivation.

## Phase 1 — Lay out the sprint, contracts first

**Contracts are the highest-risk part of this layout — give them their own
mise-en-place iterative pass, not one bullet in a list that gets waved
through by a single end-of-phase gate.** For every shared contract/interface
between chunks, define its actual shape (not just name it as a dependency)
and treat it like mise-en-place's "iterate before you plan" outlier-risk
assumptions: verify it specifically before the rest of the layout builds on
it. This is the real parallelism lever — once a shape is agreed, dependent
chunks wait on the contract instead of on each other's code — so getting it
wrong here is expensive precisely because everything downstream trusts it.

Then, in one pass, the rest:

- Use an existing sprint spec as-is if one exists; don't thin it down.
- Per chunk: Own (exclusive), explicit non-goals, hard invariants, and a
  deliverable phrased as a runnable check plus the claim it proves.
- A chunk splitting internally (`shh`'s own 2-way split) is a separate axis
  from wave-level parallelism — don't force it just because parallelism is
  the goal; if a chunk isn't actually decoupled, say so and run it as one
  agent. Wave-level parallelism doesn't need every chunk to split.
- Group chunks into waves: everything whose contracts and blockers are
  settled runs together.
- One-sentence sprint purpose + a sprint-level definition of done.
- Check available skills and load whichever fits before researching — this
  isn't a judgment call worth pausing for, just do it. The research itself
  still matters: check branches too, not just the current checkout, and
  don't let a found fact interpret itself — something already occupying the
  name/path a chunk needs might be the actual target, not a collision to
  avoid.
- Close with an explicit-exit gate. No silence, no vague "looks fine."

## Phase 2 — Run chunks through SHH, in parallel

- One wave at a time; every chunk in it runs concurrently as its own fresh
  `shh` instance — not one lead threaded across the whole sprint. Phase 1's
  contracts carry precedent now, not an agent's memory.
- Each chunk's `shh` pretask MEP carries in that chunk's Own/non-goals/
  invariants/deliverable plus its contracts, verbatim.
- A wave depending on a prior wave's output gets the real output, not a
  summary.
- `Workflow`'s `parallel()`, one thunk per chunk, scoped to one wave — not
  the whole sprint looped unsupervised. No orchestration tool available:
  same shape by hand.

## Staying visible while a wave runs

- Narrate at each `shh` stage boundary (`log()` under `Workflow`) so
  silence itself becomes the anomaly.
- `shh`'s own rule against letting an async operation report itself done
  covers real stalls — don't assume a long quiet stretch is fine regardless.
- Speed/completeness is `shh`'s dial (speed/balanced/thorough) — set
  sprint-wide in Phase 1, override per chunk at a gate if needed.

## Phase 3 — Gate after every wave, no exceptions

Each chunk's lead reports what's actually verified versus still claimed,
not "done." Explicit go/no-go on the wave as a whole — silence or momentum
from the last gate doesn't carry over.

## Cost discipline

Default shape only. Haiku effort per piece is `shh`'s call, not sprint-wide.
Never auto-escalate to a heavier or billed tier — offer it per chunk if
asked, don't default the sprint into it.

## Pairs with

mise-en-place (Phase 1 and every gate *are* mise-en-place), algo-master
(algorithmic/quantitative chunks), ponytail (code shape), propose-skill (if
a lead spots a gap nothing here covers).
