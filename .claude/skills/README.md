# The Engram Table

Repo-resident agent skills: durable memory traces that install into every
Claude session (and agent worktree) automatically on repo load — a pull IS
the update. No install step, no drift between what the repo knows and what
an agent knows.

**Non-Claude agents**: these are plain markdown — AGENTS.md (the
cross-agent entry point) directs every agent here; read each SKILL.md
below at task start as if it were part of AGENTS.md.

**The grounding pattern** (owner-adopted, 2026-08-28): diagnostic work
grounds itself in Minsky Frames — slots for *looking-for X / looks-like Y
/ because ABC / may-be-near DEF*, with fillers measured from the course,
defaults inherited from the engram tables, and course frames specializing
object frames. See step 0 of `receipt-reconcile`. Reusable anywhere an
agent is about to search pixels, logs, or code for a thing it has never
personally seen.

Two tables:

- **chainspot-engrams** — process memory: how work is accepted here
  (receipts), the claims ledger discipline, the gate model, standing owner
  policies, agent operational quirks.
- **chainspot-cv-engrams** — vision memory: what the renderer actually
  draws, chrome component signatures, the completeness invariant, the
  footgun law, hard-won diagnostic facts.

Plus procedural skills (currently `receipt-reconcile`) for multi-step
methods.

## The contribution rule

An engram is written the day it is earned, in the same commit as the work
that earned it. A lesson that lives only in a chat transcript is a lesson
the next agent pays for again. When a claim in an engram is falsified,
correct it in the same commit as the ledger retraction.
