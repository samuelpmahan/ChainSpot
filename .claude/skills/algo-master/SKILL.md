---
name: algo-master
description: >
  Engineering discipline for algorithmic and quantitative work, in three
  modes. Audit: extracting a magic number into a named setting, tracking down
  "which version/commit actually did X," answering "what's the state right
  now" from the real system instead of from memory of it, or checking whether
  a feature actually does what its name/docs claim at the code and execution
  level. Investigate: finding what actually discriminates two behaviors in
  data, including looking at contact sheets or other grouped visual evidence
  to generate a hypothesis before validating it numerically. Executor:
  reproducing a reported run through deterministic/config-driven execution
  instead of trusting the report, cross-validating metrics against each
  other, and running smart (not brute-force) grid/ablation searches across
  features. Use this whenever a task touches a threshold, a score, a magic
  constant, a detector/heuristic, a statistical claim, a "does X still work"
  question, or anything tuned or validated against data — any codebase, not
  just one project. Complements mise-en-place (pre-implementation layout) and
  ponytail (code-shape minimalism) — this one governs the quantitative
  judgment inside the work, active whether or not those two are.
---

# Algo Master

This isn't a persona bit like ponytail. It's a set of rules for exactly the
situations where sloppiness compounds silently — numbers, thresholds,
scores, and claims about what data or code actually does are the easiest
places for a plausible-but-wrong conclusion to sail through unnoticed,
because nothing crashes.

## Say precisely how sure you are

Not every true-sounding claim is equally supported, and conflating them is
where quiet corruption creeps in. Keep the distinctions separate in whatever
you write, in plain language if the audience doesn't use the formal terms:

- an assertion nobody has checked yet (a claim, a hypothesis)
- something directly observed once, unreproduced
- something checked against an independent oracle or ground truth
- something a deterministic rerun reproduced
- something a held-out validation set reproduced

Never let a result from a single run read as if it's been validated broadly.
A discrepancy between two runs, or a negative result, is itself a valid,
reportable finding — not a bug to explain away or quietly drop.

## `audit` — establish what's actually true, from the artifact itself

The common thread across all four shapes below: don't answer from what's
claimed about the code, the data, or the history — answer from reading it.

**"Reading it" means more than the current checkout.** A project with a
habit of spinning off spike/experiment branches (`agent/*`, `claude/*`,
`sol/*`, `experiment/*`, whatever the local convention is) can easily have
dozens of them nobody merged. A grep that comes back empty on the working
tree doesn't mean the thing doesn't exist — it might mean it's sitting on
one of those branches instead. Before calling something greenfield,
declaring there's nothing to reuse, or concluding a piece of old
presentation/execution code is gone for good, check `git branch -a` and
`git log --all` for the term too, not just the checked-out worktree.

**A fact about what exists doesn't interpret itself.** Finding that
something already occupies the name/path/surface you were about to use is
evidence of a real collision to route around only when the task isn't
about that something. If the task's own stated goal is to refine, replace,
or evolve X, then X already existing there is confirmation the target was
found, not a reason to build a parallel Y next to it instead. Before
recommending "avoid it, name yours something else," check that conclusion
against what the task actually says it's trying to do — an existing thing
sharing a name with what you're about to build is exactly what you'd expect
to find when the task is "make this real," and treating it as a reason to
sidestep gets the whole point backwards.

**Numeric extraction.** Pulling a magic number into a named, tunable setting:
1. Inventory the literal in context — where it's actually read, not just
   where it's defined.
2. Before naming it, check it isn't a coincidental duplicate of another knob
   elsewhere that happens to share a value — verify by reading what each one
   actually gates, never by comparing the numbers alone. Equal values are
   not the same knob until proven so.
3. Check it isn't gating dead or inert code: trace what happens when the
   guard trips. If the very next check downstream would reject it anyway
   regardless of this one, it's a dead guard — don't manufacture tunability
   for code that can't be reached.
4. Thread it through with its current value as the default; behavior must
   not change. Prove that, don't assume it: pin an output fingerprint before
   the change, confirm it's identical after.
5. Full test suite and typecheck green, then an actual diff review — read
   what changed, don't stop at "tests pass."
6. If any of this is delegated, the number still needs two independent
   sets of eyes: whoever it's delegated to validates their own delegate's
   numbers, and you validate theirs.

**Finding "that one version."** When the ask is "what actually changed to
fix X" or "which commit did this": don't infer it from commit messages or a
handoff doc's say-so — locate the real commit (bisect, blame, or just read
history against the actual behavior change) and verify the diff yourself.
Flag it explicitly if a doc's claimed commit turns out to be the wrong one —
that's a real discrepancy, not a nitpick. Once found, explain each claimed
mechanism against the literal code and, where you can, against the data that
motivated it — a mechanism "explained" without re-deriving its numbers is
still just a claim.

**What's the state right now.** Answer from the live system, not from
memory of what should be true: current branch/HEAD, a dirty-worktree
inventory grouped by which thread of work each file belongs to, confirmation
that any claimed objects/hashes are actually readable and pass integrity
checks, every discrepancy between a handoff/doc and what you actually found,
and the smallest safe next action. Don't modify anything while answering
this — inspect and report first.

**Does the feature actually do what it claims.** A name, docstring, or
comment is not proof of behavior. Read the code path it actually executes;
run it and observe real output where you can, especially at the edges —
unreachable branches, a config value that's parsed but never wired to
anything, a guard that never fires. This is the extraction-mode dead-code
check, generalized to any claimed behavior, not just knobs.

## `investigate` — finding what actually discriminates two behaviors

Identify a pattern, then fix it — don't poke and prod at random.

1. Measure both groups before hypothesizing why they differ.
2. **When the data is visual** (images, courses, contact sheets — a grid of
   cropped examples laid out together), look before you compute. Scan the
   grid for what's visually different about the group that behaves
   differently; that's how a candidate discriminator gets nominated in the
   first place. Then translate the hunch into an actual measurable signal
   and validate it with the same rigor as anything else here — a visual
   pattern that "looks obvious" on one contact sheet is a hypothesis, not a
   result, until it's measured. (If the task is literally a full course
   orientation/annotation-review pass, that's the more specific `lab-orient`
   skill's job — this rule is the general principle underneath it, useful
   any time visual grouping is the fastest way to spot a candidate pattern.)
3. Report negative and inconsistent results as plainly as positive ones. A
   ratio that cleanly flags a category but doesn't scale with severity is
   worth saying exactly that, not smoothing into a bigger claim than it earned.
4. Don't collapse a multi-signal decision into one opaque score without
   keeping the components. A discriminator is easier to trust — and to debug
   six months from now — as a named, interpretable field than folded
   silently into one number nobody can decompose later.
5. A pattern found in one case is a claim until it's checked against a
   second, independent one: a different course, a different dataset,
   detected coordinates instead of ground truth. Say which kind of evidence
   you actually have; don't let a working demo imply more coverage than it has.
6. A throwaway script that found something real is worth offering to
   formalize — a registered measurement, a real test — rather than silently
   discarding. Offer it; don't decide it for the user.

## `executor` — reproduce, cross-validate, search smart

A reported number is a claim until you've re-run it yourself.

1. **Reproduce before trusting.** If a deterministic or config-driven
   execution path exists — something that resolves a sparse config (only
   the deviations from baseline) into a full parameter set and hashes the
   result, the way ChainSpot's threeFactor engine does — reproducing a
   claimed run means re-running that exact resolved config, not re-typing
   the numbers someone reported. Where a zero-argument deterministic
   primitive exists for this (the `dev72`-style "no flags, nothing to get
   wrong" command), prefer it over hand-assembling the equivalent call —
   that's the whole reason such a primitive gets built. If no such harness
   exists yet, "deterministic execution" is the thing to ask for: a rerun
   that takes the same inputs and produces the same output every time,
   before any tuning work builds on top of it.
2. **Isolate and protect the baseline.** Do tuning/search work in a
   worktree or branch so the golden/pinned baseline stays reachable
   throughout. Any regression against it gets investigated immediately, not
   absorbed into a "net improvement" framing.
3. **Cross-validate metrics against each other**, not just against one
   pass/fail gate. If two measures should move together (a severity ratio
   and an independently-derived detour length, say), check that they
   actually do on the same data before trusting either alone. Pick which
   measure is actually being optimized before running a search — a
   saturated baseline (already 100%, already perfect) can't show
   incremental progress, so search against whichever metric still has room
   to move.
4. **Search smart, not brute-force.** A sparse config system makes this
   cheap: each config file states only what differs from baseline, so it
   *is* one experiment. Vary one axis at a time (or use sibling pairs that
   differ in exactly one knob) so a result can be attributed to what
   actually changed, prioritize knobs whose effect or blast radius is
   unknown, and don't burn search budget re-confirming a knob already
   proven inert or already validated.
5. A rerun's result is still subject to the epistemic ladder above — label
   it precisely (reproduced once vs. validated against a held-out set,
   etc.); a single successful reproduction doesn't license a broader claim.

## Plain words, every time

Math and domain jargon get a short plain-language aside at the moment
they're used — every occurrence, not just the first. Memory of a term
explained three replies ago fades faster between sessions than it should;
write as if this is the first time it's being read. ("Gradient" means how
fast a value changes as you move — say that inline, don't assume it stuck.)

## Boundaries

This governs quantitative judgment: what to trust, what to verify, when a
number is safe to promote to a stronger claim. It doesn't govern code shape
(pair with ponytail for that) or the pre-implementation walkthrough (pair
with mise-en-place for that) — run alongside either. If a task doesn't touch
a threshold, score, measurement, historical claim, or extracted constant,
this skill has nothing to add.
