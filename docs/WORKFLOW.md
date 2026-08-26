# OSS orchestration protocol — ChainSpot

> Historical orchestration record (2026-08-25), not the current branch or
> accuracy contract. See
> [`INTAKE-ENGINE-HANDOFF.md`](./INTAKE-ENGINE-HANDOFF.md) before transferring
> or resuming the intake-engine work.

Pre-agreed by Sam and Claude, 2026-08-25. This dir is gitignored (`artifacts/`).
Claude reads every file here at the START and END of every turn.

## Pattern

**OSS** = one Opus + two Sonnets per lane. A tier above SHH.
- The **Opus** writes tests around the pre-agreed interface. It does not build.
- The two **Sonnets** build against that interface, in isolated git worktrees.
- Cross-validation: each Sonnet reviews the other's piece, never its own.

## Lanes

| Lane | Branch | Owns |
|---|---|---|
| alg | `lab/alg` | what the algorithm emits |
| ui | `lab/ui` | what gets drawn, and the LAB UI view |
| demo | `demo/mock-server` | the product surface; grows as needed |

No file may be owned by two lanes. The interface contract names the seam.

## Acceptance gate (Sam's requirement, verbatim)

> the CLI output itself must be self evident for acceptance, with an
> explanation of why everything can build together safely but be dropped
> easily and safely.

So: a lane is accepted when a human reads `./lab <command>` output and can
accept it on sight, without opening code. "Tests pass" is not acceptance.
Every piece must be droppable by flipping config, not by reverting commits —
this maps onto the existing ABFeature model (baseline default-ON,
deviation default-OFF, parity test pins frozen behavior byte-for-byte).

## Reporting

Subagents cannot post into the chat directly. Therefore:

- Each running agent writes `artifacts/orchestration/<lane>-progress.md`,
  appending small wins as they land. Newest entry at the top.
- Claude checks this dir at the top and bottom of every turn and reports up.
- Sam and Claude monitor and plan together from these files.

## Standing rules

- Nothing is pushed without showing Sam the verbatim content first (AGENTS.md).
- Nothing irreversible. Recovery tags exist: `prelanding/2026-08-25-*`.
- `main` is dead. Lanes stack on the LAB trunk, not on main.
- Everything lives on D:. C: has 1.7% free.

---

## The receipt (added 2026-08-25, supersedes the acceptance wording above)

The Opus in each OSS is not there to be clever. It is there to be thorough.
Its job is to produce **the output it would itself want if it had to debug this
code cold** — and that output, the *receipt*, is the main course of acceptance.

**The Opus's first deliverable is the receipt format, not tests.** It is written
and agreed BEFORE the Sonnets build, exactly like the interface. Tests come
second and do one thing: assert the receipt tells the truth.

A receipt is the literal text (and referenced images) a `./lab` command prints.
A human accepts or rejects the lane by reading it. Not by reading code, not by
watching tests go green.

Every receipt states, for the run it describes:

1. **What ran** — config name, `paramsHash`, input raster, course.
2. **What it saw** — each object found, with its frame stated (image-px).
3. **What it rejected, and why** — the rule that rejected it, by name, and the
   value that failed it against the threshold it failed.
4. **What it could not see** — occluded, out of crop, or otherwise unobserved.
   Never silently absent. "Not seen" and "not there" are different lines.
5. **Every number with provenance** — value, and where the threshold came from,
   or `UNKNOWN` in plain sight. An unexplained constant is a landmine.
6. **What changed vs the frozen baseline** — or "no change", explicitly.

Rules of thumb:
- If a human has to open a source file to accept the work, the receipt failed.
- If a number appears with no provenance, the receipt failed.
- If something is missing from the output with no line explaining why it is
  missing, the receipt failed. That exact silence has destroyed working tee
  detection three times.

## Generated triple

One template generates three things together, never one without the others:

    ABFeature  →  FeatureRender  →  Receipt

The behavior, the way to see it, and the way to accept it. A feature that
cannot be seen and cannot be read cannot be added.

## Working rhythm

Small sensible steps that accumulate. Prefer ten landings a human can each
accept on sight over one large landing that requires trust.

---

## The waiting room (added 2026-08-25)

Lanes are built in parallel on purpose. A lane commit is a **half**, not a
finished thing. Halves meet in a waiting room and must demonstrate that they
combine before the work counts as done.

**The waiting room is `integration/weave`.**

### Rules

1. **Lanes branch from the trunk. Never from the waiting room.**
   The waiting room accumulates; it is not a base. (AGENTS.md already says
   `staging/*` accumulation branches are never a base — same rule.)

2. **Merge lanes INTO the waiting room. Never merge the waiting room back
   into a lane.** If a lane needs something from another lane, that is a sign
   the seam was drawn in the wrong place — redraw the seam, do not cross-merge.

3. **A merge is not finished when it merges cleanly.** It is finished when it
   produces something a human can look at: a real run, on real course data,
   with a receipt. Clean merge + green tests is not a demonstration. A picture
   and a receipt is.

4. **If it cannot be demonstrated, it goes back to the lanes.** The waiting
   room never holds a combination nobody has seen work.

5. **The waiting room is disposable.** Rebuild it by re-merging the lanes.
   Nothing lives only there. If something exists only in the waiting room, it
   is in the wrong place.

### What a demonstration looks like

The mask renderer, 2026-08-25, is the reference:

- `lab/alg` alone: emitted `dims`, nothing drew it.
- `lab/ui` alone: renderer present, always fell to the stub path.
- Merged: `Renderer inventory: 2 rendered, 7 stubbed`, two PNGs, a receipt
  showing `1290 x 2111 = 2,723,190 vs 2,723,190 bytes -- MATCH`, and
  parity + the DashsTrack oracle unchanged at 18/18 across G1-G4.

Neither lane worked alone. That is the point, not a defect.

### Why bother

Parallel lanes without a forced combination checkpoint drift apart quietly and
you find out at the end. Forcing the demonstration early makes the drift small
and cheap. The gate is what makes the parallelism safe, not what slows it down.

---

## Branch topology (added 2026-08-25)

This is git-flow shaped. It already existed before the CHSPT-82 rebuild
(`origin/staging/demo`, `origin/staging/vision`, both last touched 2026-08-17)
and lapsed when the rebuild moved every file. This re-establishes it on the
new lineage.

```
main                      pinned. hard to move. release pointer, not a workspace.
 |
 +-- staging/lab          waiting room for LAB + algorithm
 |     +-- lab/alg        what the algorithm emits
 |     +-- lab/ui         what gets drawn, LAB workbench
 |     +-- lab/cv-harness how features get run and scored, sandboxed
 |
 +-- staging/demo         waiting room for the product
       +-- demo/*         product lanes
```

### Naming

`<area>/<piece>` — area is `lab` or `demo`, piece is a short kebab noun.
`staging/<area>` is the waiting room for that area. Nothing else.

### Rules

- **Feature lanes branch from the trunk, never from a `staging/*`.**
  Staging accumulates. It is never a base. (AGENTS.md already says this.)
- **Lanes merge INTO staging. Staging never merges back into a lane.**
- **A merge into staging is not done until it demonstrates** — a real run on
  real course data, producing something a human looks at. See "The waiting
  room" above.
- **`staging/*` is disposable.** Rebuild by re-merging the lanes.
- **main moves rarely and deliberately**, from a staging branch that has
  demonstrated, never from a lane.

### Archived, do not merge

`origin/staging/demo` and `origin/staging/vision` are PRE-REBUILD lineage.
They use `src/lib/detectors/...`; the rebuild uses `packages/alg/src/...`.
Shared history ends at 4da01fb (2026-08-17). They cannot be merged forward.
Treat them as reference only — the same rule as `docs/unported/`.

`staging/demo` must be re-established on the new lineage from `demo/*` lanes.

---

## Candidates: the waiting room plus ABFeatures

The waiting room and the ABFeature system combine into an experiment surface.

An ABFeature is behavior with an easy off switch: `baseline` features default
ON, `deviation` features default OFF, so the default config reproduces frozen
behavior byte for byte. That means a candidate idea can land **without changing
anything**.

So: several isolated candidates for the same problem each land in the waiting
room as their own default-OFF feature. They coexist. Nothing competes.

**Comparison is a config choice, not a merge.** Turn on candidate A, run it,
read the receipt. Turn on B. Turn on both. Every run is stamped with a
`paramsHash` of the resolved config, so two runs are always distinguishable
and always reproducible.

**A large feature head is several candidates plus a way to combine them.**
Not one branch that grew.

### Why this matters here

Three branches — `codex/ab-tbs-course-width`, `codex/ab-tbs-orient-rails`,
`codex/ab-tbs-ribbon-primitives` — each independently rewrote the same file,
`st.fourLaneSensor.ts`. Three competing versions, none merged, no way to say
which is authoritative. They were isolated but had no meeting point, and
isolation without a meeting point is just divergence.

As default-OFF features they would have been additive instead of competing,
would have coexisted in `staging/lab`, and could have been compared by flipping
config. The collision was a process failure, not a code failure.

### Rules for candidates

- A candidate is a `deviation` feature, default OFF. Never an edit to a shared
  file that another candidate also edits.
- If two candidates must edit the same file, the seam is wrong. Extract the
  thing they both need first, as its own piece.
- Every candidate ships its own render and its own receipt. A candidate you
  cannot see is a candidate you cannot judge.
- Dropping a candidate is deleting a config entry, never reverting commits.
- The default config stays byte-identical while candidates accumulate. The
  parity test is what proves it.


---

## Why cv-harness is separate from ui

`lab/cv-harness` runs and scores features. `lab/ui` shows them to a human.
They are deliberately not the same lane.

If the code that tests a feature and the code that displays it are the same
code, a bug in it hides in both places at once, and you have no way to notice.
Separate them and a disagreement becomes visible: the harness says a candidate
scored X, the workbench draws something that does not look like X, and now you
know one of them is wrong.

That is the same reason two independent agents beat one careful agent -- two
paths to an answer catch what one path cannot. Applied to the tooling itself.

The practical benefit: candidates can be run and scored in the harness without
touching the workbench, so a broken experiment cannot break the thing you use
to look at experiments. Cheap models can iterate in the sandbox; the workbench
stays trustworthy.

They meet in `staging/lab` like everything else, and the meeting is the check.
