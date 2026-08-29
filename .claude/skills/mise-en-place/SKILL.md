---
name: mise-en-place
description: Before writing or editing any code, config, or files — even for a task that looks small, and even in auto/fast mode where confirmation is normally skipped — lay out the plan's parts and how they fit together end-to-end in plain chat text, then stop and wait for an explicit, unambiguous exit signal before touching anything (not silence, not a vague reply, not the conversation just moving on — a real "go"). Use this as the default pre-implementation checkpoint for every coding task: name every file/component/system involved, walk the actual flow between them in order, state assumptions and risks explicitly, call out impact on existing behavior, and define any jargon or non-obvious term in a plain-language aside every time it comes up, not just the first time. Skip only if the user has explicitly turned this off earlier in the conversation (e.g. "skip mise-en-place", "turn it off") — resume once they say to turn it back on. Trigger this proactively, before locking in a plan; don't wait to be asked by name. For a task big enough that formal planning (this environment's Plan Mode, if available) would normally kick in, run this iteratively — hunting and verifying the few outlier-risk assumptions specifically, looping until a pass comes up dry — before any formal plan gets written, not as a single pass folded into the plan itself.
---

# Mise en place

Mise en place is a kitchen term: get every ingredient measured, chopped, and
within reach before the stove goes on. Applied here, it means the same thing
for a coding task — before touching a single file, walk through every piece
involved, how they connect, and where things could go wrong, out loud and in
plain language, long enough for a human to actually check it.

The point isn't ceremony. Someone who isn't steeped in the codebase or the
domain, reading a clear enough explanation, can sometimes catch something an
expert glosses over — but only if the explanation is actually clear, not
compressed into jargon they have to take on faith. Writing the layout out is
what creates that chance.

This is a stop, not a suggestion. Nothing proceeds without an explicit
approval, and that holds exactly as hard for a small task as a large one —
see why below, it's not the intuitive direction.

## When to do this

Do this before starting implementation on essentially any coding task, not
just the ones that look complicated — small tasks hide small mismatches just
as easily, and "this one's simple" is exactly how the simple ones go
sideways. Default to running this every time before you create or modify
code, config, or files, including in auto/fast mode where confirmation for
routine calls is normally skipped. This checkpoint is the deliberate
exception to that.

It's tempting to assume a short, simple-looking request needs less of this
because there's obviously less to misread. It's actually the opposite, and
here's the concrete reason: think of the task as understood and the task as
intended as two vectors, and misalignment as the angle between them. A short
vector's direction is easy to get wrong by a lot without it looking wrong —
a two-sentence request carries so little detail that a real misread and a
correct read can look nearly identical from the outside, right up until the
difference lands in the diff. A long, detailed request gives more surface to
check the angle against — more places a misread would visibly disagree with
something else already stated. Less signal to work with isn't lower risk,
it's just risk that's harder to see coming — which is the opposite of a
reason to skip the check.

Skip it for pure reads, explanations, or non-implementation work — answering
a question, running a diagnostic, searching the code. It's specifically the
gate before anything that changes state.

**Toggle:** if the user explicitly turns this off in the conversation (e.g.
"skip mise-en-place," "turn it off for now"), stop running it for every
subsequent task in that conversation — don't ask again each turn, and don't
quietly bring it back after one skip. Only resume once they explicitly say
to turn it back on (e.g. "turn mise-en-place back on"). This is a standing
toggle for the session, not a one-shot skip.

If `EnterPlanMode`/`ExitPlanMode` tools are available in this environment,
they can carry the layout content, but don't let a single approve/reject
prompt stand in for the exit condition below — that's the exact pattern
this skill exists to be stricter than: a plan gets presented once, and
anything short of actively hitting "revise" reads as acceptance. The bar
here is the reverse default. Whether the layout is delivered through those
tools or as plain chat text, nothing proceeds until the reply itself
contains an explicit go, per the next section.

## For tasks big enough to warrant formal planning: iterate before you plan

A plan is a chain of assumptions and abstractions — dozens, sometimes
thousands, once you count everything a large task actually rests on. Even if
each one only has a small chance of being wrong, the odds the whole chain
holds isn't those small numbers added up, it's them multiplied: reliability
compounds down, and it drops fast. Worse, the risk is never evenly spread —
most of a given chain is routine, but a handful of assumptions are
genuinely more likely to be wrong than the rest, and those are the ones that
actually sink a plan.

So for a task big enough that formal planning would normally kick in (this
environment's Plan Mode, if it's in play, or just "write up a real plan
before touching anything" otherwise), one pass of the layout below usually
isn't enough. Iterate it first, specifically hunting the outliers, before
any formal plan gets written:

1. Run the layout (parts, flow, assumptions, risks, impact, jargon) as a
   first pass.
2. Don't treat every assumption or risk as equally likely to bite. Flag
   which few are actually higher-risk than the rest — a genuine unknown, a
   dependency you haven't verified, a place two people could reasonably
   read the requirement differently — and go verify those specifically
   before moving on: read the code, run the check, ask the targeted
   question. Don't just list them and hope.
3. Present what got resolved and what's still open. If the reply surfaces a
   correction or a new constraint, don't just fold it in and move past it —
   a correction often exposes another assumption sitting underneath the one
   that just got fixed. That's the next pass, not the end of this one.
4. Keep iterating until a pass turns up nothing new — no fresh high-risk
   assumption, no correction. That's convergence, not a fixed number of
   rounds.
5. Only then move into the actual formal plan — via this environment's Plan
   Mode if it's in play, or just the plan document itself otherwise —
   building it on a foundation that's already had its likeliest failure
   points found and fixed, instead of discovering a bad assumption three
   layers into a plan that now has to be partly re-derived.

This doesn't replace the explicit-exit gate below — it's what happens
before the gate, so that what the gate is actually approving has already
survived the rounds most likely to break it.

## What to produce

Do the research needed to get these sections right before writing them —
read the actual files, check how the existing pieces really connect, don't
guess at behavior you can verify. Then lay it out in the chat. Adapt the
headers to the task, but keep the substance:

### 1. The parts
Every file, component, service, or system this touches, named plainly, with
one line on what it currently does and what role it plays in this change.

### 2. How they fit together, end to end
Walk the actual flow in order: what happens first, what triggers what next,
where data or control passes from one part to the next — as if pointing at
each piece in sequence. This is the section that catches "wait, I didn't
realize X touched Y" before it becomes a bug instead of a sentence.

### 3. Assumptions
Anything taken as given but not actually verified — an API's behavior, a
config value, that a library does what its name implies, that nothing else
reads this file. State it outright so it's checkable, not buried.

### 4. Risks
What could plausibly go wrong for this specific plan: edge cases, a
migration that's hard to undo, a change that only breaks under load or in
production, something another part of the system quietly depends on. Not a
boilerplate list — the real ones visible for this task.

### 5. Impact on existing stuff
What currently-working behavior this plan touches, and how it could shift —
including side effects a user or another system relies on today that aren't
the point of the change but could move anyway.

### 6. Jargon, defined as it comes up
Whenever a term isn't plain English — a library-specific concept, an
acronym, a pattern name, framework internals — add a short plain-language
aside right there, the same moment it's used. Do this at every occurrence in
the layout, not only the first, since the reader may be picking this up
between sessions with the earlier explanation already faded. Treat each
mention as if it's the first time it's being read.

## Then stop and wait for an explicit exit

Close with a direct question along the lines of "Does this match what you'd
expect? Anything to correct before I start?" — and actually wait for a
reply. The default here is the opposite of a typical approve/revise prompt,
where presenting something once and getting anything other than a
correction counts as acceptance. Don't create files, edit code, or run
anything that changes state until the reply is an actual, explicit go —
something that plainly says to proceed ("go," "yes, do it," "looks right,
start," "proceed"). Silence, a vague acknowledgment ("ok," "sounds fine," a
thumbs-up), a reply that only addresses one part of the layout, or the
conversation simply moving to something else are all not that — treat them
as staying parked, not as consent, and ask again rather than guessing.

If the reply corrects something — a wrong assumption, a missed part, a risk
they weigh differently — fold the correction in, present the updated layout
back, and close with the same question again. This is a loop, not a single
round: revise, present, ask, wait, and repeat as many times as it takes.
Each pass needs its own explicit exit — an earlier "looks good" doesn't
carry over to a layout that changed after it.
