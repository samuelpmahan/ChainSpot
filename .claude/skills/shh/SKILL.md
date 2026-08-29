---
name: shh
description: >
  Sonnet-Haiku-Haiku: a four-step pipeline for implementing one ticket or
  feature-sized piece of work with a cheap fleet instead of one agent doing
  it serially. A Sonnet lead splits the ticket into two genuinely separable
  pieces, then researches whatever the final integration will need WHILE two
  Haiku workers implement their pieces in parallel — not idle-waiting. The
  two Haikus cross-review each other's piece (never their own) before the
  lead sees anything. The lead does the final review, informed by its own
  research and the cross-review notes, and integrates. Haiku effort can be
  bumped above default per piece when it's genuinely hard enough to be worth
  it — a judgment call, not a fixed setting. Use this whenever asked to run
  something through "SHH" or the Sonnet-Haiku-Haiku pipeline, or when a
  ticket clearly splits into two independent pieces and cheap parallel
  execution with built-in cross-review would beat one agent doing it
  start-to-finish. Doesn't fit every ticket — say so rather than forcing an
  arbitrary split when the work is one continuous thread of reasoning.
---

# SHH (Sonnet, Haiku, Haiku)

## Before the pipeline starts: the pretask MEP is the injection point

Before any splitting happens, the lead gets the same explicit-stop layout
mise-en-place always requires. For a piece of work that already has real
design context behind it — a prior planning conversation, a written spec,
someone else's notes — this pass is not a fresh five-minute guess at what
the ticket means. It's the point where that existing context gets carried
in, faithfully, and the human's explicit go on it is literally them
filtering what the lead is about to receive before it becomes the lead's
entire understanding of the task.

Skipping this, or treating it as a rubber stamp, means the lead reconstructs
"what this actually needs" from whatever compressed one-line description it
was handed — which is exactly where assumption and slop come from, and
exactly the cost this pipeline exists to avoid. If a richer spec already
exists for this piece of work, carry its actual ownership boundaries,
exclusions, hard rules, and deliverable into the layout — quote them, don't
paraphrase the precision out of them. If no such spec exists yet, this is
where it gets written, same as any other mise-en-place pass.

Only once that layout gets an explicit go does step 1 start.

## The pipeline

1. **Split.** The lead reads the ticket and splits it into two pieces that
   are actually separable — separable enough that two workers can implement
   them without stepping on each other's files or shared state. If it
   doesn't split cleanly, say so rather than forcing an arbitrary cut; not
   every ticket fits this shape.
2. **Implement + research, in parallel.** The two Haiku workers implement
   their pieces at the same time the lead researches — not idle-waiting on
   the workers. What the lead researches: whatever the final review and
   integration will actually need that isn't obvious from the ticket alone
   — existing conventions the pieces need to match, a gotcha in the
   surrounding code, exactly how the two pieces need to fit together at the
   seam. This is what makes the final review fast and informed instead of a
   cold read of two diffs.
3. **Cross-review.** Before the lead sees anything, the two Haikus review
   each other's piece — never their own. Each flags what an actual reviewer
   would: does the other piece look right, does it actually satisfy what the
   split's boundary needed to guarantee.
4. **Final review.** The lead reviews both pieces plus the cross-review
   notes, informed by its own research from step 2, and either integrates
   them, sends one back for a fix, or fixes it directly if it's small enough
   that another round-trip isn't worth it.

## Effort is a judgment call, not a fixed setting

Haiku workers don't have to stay at whatever the default reasoning effort
is. Bump a worker's effort when its piece is genuinely hard enough that a
cheap pass would likely miss something, and getting it right the first time
is worth the extra cost over catching it later in cross-review or final
review. This is still being calibrated — there's no fixed rule yet for what
counts as "hard enough," so lean on judgment per piece rather than a
blanket policy, and it's worth noting afterward whether a bump actually
helped, so the calibration improves over time instead of staying a guess.

## Don't let an async operation report itself done

A worker (or the lead) will sometimes need to kick off something
long-running — a test suite, a build, a background process — as part of its
piece. The failure mode to actively guard against: starting it, watching
only for the success marker, and treating silence as "still running" when
it's actually hung, crashed, or exited early. That gap is easy to miss
because a stalled process and a slow-but-fine one look identical from
outside until something explicitly checks.

So: track any such operation to its actual terminal state, not a
fire-and-forget. A single expected result gets a real blocking wait for its
one completion signal, not a glance partway through. A process being
watched for output needs its watch to cover every terminal state it could
actually hit — success, error, crash, unexpected exit — not just the happy
path; a watch that only matches the success line stays silent through a
crashloop or a hang, and that silence is indistinguishable from progress.
If nothing has confirmed the operation's real end state, it isn't done —
say that plainly rather than reporting the step finished because nothing
has failed yet.

## Speed vs completeness — a dial, not a fixed setting

Default is **balanced**: the pipeline as written above. Two other settings,
picked once for the run or overridden per-piece when asked:

- **speed** — lighter cross-review (a sanity pass, not a full re-derivation
  of what the boundary needed to guarantee), effort stays at default
  throughout, the lead's research phase stays tight to what final review
  strictly needs, final review trusts the reported result rather than
  re-checking it independently.
- **thorough** — cross-review re-verifies against the actual spec/tests, not
  just a read-through; effort gets bumped more liberally; the lead's
  research phase is more exhaustive; final review re-runs whatever it can
  itself rather than trusting the pieces' own reports of success.

Say which setting is in play when it isn't the default — a fast pass and a
thorough one can look identical in output shape, and the difference matters
when something's found wrong later.

## When it doesn't fit

Some tickets are one continuous thread of reasoning that doesn't parallelize
without one worker blocking on the other's output — forcing a split there
just adds coordination overhead for nothing. Say plainly that the ticket's a
poor fit for SHH and do it the normal way, one agent start to finish,
instead of manufacturing a boundary that isn't really there.
