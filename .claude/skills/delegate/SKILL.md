---
name: delegate
description: The ChainSpot delegation ladder — route every task to the cheapest capable model tier, with pre-written rails. Load whenever orchestrating agents in this repo, before dispatching any subagent, and whenever tempted to do implementation work in the lead context.
---

# Delegate (the ladder, as one word)

## Policy (owner protocol 2026-08-28)
- If a task feels cheap: Haiku does it. Haiku fails -> Sonnet. Sonnet fails -> correct the brief, retry Sonnet. Still fails -> Opus. The lead (Fable) enters LAST, once failures are spread out on the table as a characterized problem.
- The lead announces the tier ("sending to Haiku: X") and dispatches; the owner overrides by speaking up. The lead never asks permission for an obvious tier.
- Ambiguous tier ONLY: use AskUserQuestion, 2-3 options, recommended option first. If ambiguity is rare-but-real, that is the exception path, never the default.
- The lead never holds the code. Lead tokens buy judgment (contracts, review, synthesis, owner conversation); spending them on edit-build-test loops is the most expensive possible use of the session and degrades the judgment at the same time.
- Owner boundary experiments are welcome: Sonnet is near-Opus for most coding; Opus earns its cost on the OPERATOR side (coordinating a lane, holding a contract, adversarial review). OSS = Opus operating + two Sonnets building — see The OSS Triangle below.

## Tier table
| Tier | Use for | Notes |
|---|---|---|
| Haiku | Mechanical, single-file, spec-exact edits; report formatting; receipt line additions | Needs rails PRE-WRITTEN (exact file, exact change, hard rules) — but so does every model including the lead; the worst wander on record was the largest model |
| Sonnet | Multi-file implementation; judgment within one lane; investigation with a defined question; test repair | Default builder. Push its boundaries — promote before assuming Opus is needed |
| Opus | Cross-cutting audits; writing binding contracts (C1-C6 style); adversarial review of another lane; operating an OSS team | The operator tier |
| Fable (lead) | Plan, contracts, neutral review, synthesis, talking to the owner | Enters last; never edit-build-test |

## Brief template (every dispatch includes)
1. Read .claude/skills/chainspot-engrams/SKILL.md first (and chainspot-cv-engrams for anything touching detection).
2. Exact deliverable: named file path(s).
3. Hard rules: never change a knob default, threshold, test expectation, or pin to make something pass — flag it instead; no commits/pushes/resets unless explicitly granted; rebuild packages/alg before testing (LAB runs dist/).
4. Evidence bar: every claim carries a receipt pointer; "couldn't find it" without a classification is not a finished task.
5. Scope fence: what is explicitly OUT of scope.

## Known traps
- A builder graded by its own tests will move the goalposts — reviewer is always a different context.
- Worktree spawns may land on a stale base: check `git log --oneline -1` first; write a progress file immediately (zero-change worktrees get auto-deleted).
- Subagents cannot spawn subagents — an Opus "lead" of an OSS team is briefed with its Sonnets' outputs, not the ability to spawn them.

## The OSS Triangle (owner canon, 2026-08-28)
The tiny structure that is insanely powerful:
- **Split the task on CONTEXT BOUNDS between the two Sonnets** — each half sized to fit one Sonnet's context cleanly, and the halves chosen as complementary pairings (instrument + fix; forensics + repair; index-A + index-B), never two copies of the same job.
- **Opus enforces the contracts** set by the user + lead — it holds the C1-C6-style binding document and judges deliverables against it, not against vibes.
- **The Sonnets cross-review each other** — each reviews the other's half against the contract before anything merges.
- **Opus final review** — one pass over the combined result, with the authority to bounce either half.
Every edge of the triangle is a context that cannot influence what it judges.

## ABFeature builds run the OSS Triangle (owner policy 2026-08-29)
Any new ABFeature (a default-OFF config-toggled deviation: new feature module + registry/gate-sets/schema wiring + config JSON + receipt section + fingerprint-pin update) is built under the OSS Triangle as STANDARD, not as an escalation. The whole point of ABF is trustworthy comparison, so the build itself gets the structure where no lane grades its own work: split builder halves on context bounds (typical pairing: feature+wiring | tests+receipts), cross-review, Opus contract/final review before the config is trusted. A single-Sonnet ABFeature build is the exception and must be followed by the review half of the triangle (independent adversarial review + contract check) before its receipts are treated as evidence.

## Supporting patterns (each caught real bugs on 2026-08-28)
1. **Instrument before fix** — the measuring lane lands first, pins exact defect counts, and the fix lane is forbidden from touching the instrument. (The ./lab digits scoreboard found two unknown failures mid-build this way.)
2. **Contract, not vibes** — the lead does forensics and issues a binding contract; the builder builds to it; disagreements become contract amendments, never silent divergence.
3. **Independent cross-check lane** — a mechanism sharing zero code/assumptions with the thing under test (the legacy-classifier head-to-head settled every disputed read pixel-by-pixel).
4. **Territory fences** — every brief names what is OUT of scope; no builder may bend its own measuring stick.
5. **Baseline capture + byte-diff** — pre-change dumps saved, post-change diffed line-for-line; only the intended lines may change.
6. **Fixer + comber pair** — after any leak-class fix, a second agent combs the codebase for other instances of the same class.
7. **Waiting-room merge** — lanes combine in one place, re-demonstrate end-to-end, THEN present for approval; never merged on each lane's own green.
The common thread: **every lane's output is validated by something that lane cannot influence.**
