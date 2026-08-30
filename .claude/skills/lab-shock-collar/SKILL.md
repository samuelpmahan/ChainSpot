---
name: lab-shock-collar
description: >
  ChainSpot anti-throwaway-tool discipline. Load whenever an agent is about to
  write an ad-hoc Python/JS/TS/shell script, use a scratch analysis program,
  directly inspect algorithm artifacts with custom code, or re-run a one-off
  script. LAB is the canonical embodied interface. One-off code is allowed only
  under a narrow warrant when LAB genuinely cannot answer the question; before
  a second use the capability must be checked for promotion into LAB.
---

# LAB Shock Collar

ChainSpot already has an embodied working environment. Bypassing it with a pile
of disposable scripts teaches the current agent something while teaching the
next agent nothing.

The default answer to "I'll just write a quick script" is **no**.

## Rule 0 — ask LAB first

Before writing investigative code:

1. Run or inspect `./lab --help`.
2. Inspect the relevant recursive help (`scope`, `sweep`, `gates`, `detectors`,
   `cases`, `invariants`, etc.).
3. Ask whether the needed operation is already expressible through LAB.
4. If it is, use LAB even if a private script would be faster for this one agent.

The point is not command purity. The point is accumulating reusable embodied
capability.

## The one-shot warrant

A disposable script may exist for **one execution** only when all are true:

- LAB cannot currently answer the concrete question;
- the question must be answered before it is sensible to design the permanent
  interface;
- the script does not create a second implementation of detector/engine logic;
- the script calls real project code for project semantics rather than
  re-implementing it;
- its output is tied to one named diagnostic question.

Before running it, state in the working notes:

`ONE-SHOT WARRANT: <question> | LAB gap: <missing capability>`

If you cannot state the LAB gap precisely, do not write the script.

## The second-use tripwire

**Before a second invocation of the same script or materially equivalent script: STOP.**

Do all of:

1. Re-check the relevant LAB help.
2. Decide whether this capability is useful beyond the original diagnostic.
3. If reusable, it is now a LAB candidate. Do not run the throwaway again.
   Implement/propose the smallest proper LAB operation, measurement, receipt
   field, or existing-command extension.
4. If genuinely one-off, record why, run at most once more only when necessary
   to close the original question, then delete it.
5. Surface the decision to the owner in the next report:
   `PROMOTE TO LAB` or `ONE-OFF, DELETED`, with one sentence why.

A **third use is prohibited**. At that point it is demonstrably a tool.

## Never allowed

- a parallel Python/JS implementation of detector math that already exists;
- a script whose only reason to exist is "easier than learning LAB";
- repeated scripts that differ only in hard-coded hole/course/coordinates;
- leaving diagnostic scripts around unlabeled in `scripts/`, repo root, `/tmp`,
  artifacts, or a worktree;
- using a throwaway program as authoritative evidence when a LAB receipt can
  expose the same fact;
- creating a script and then documenting how to rerun it instead of making the
  operation discoverable from `./lab --help`.

## What counts as promotion

Promotion does **not** require a giant new command. The reusable thing may be:

- one new measurement in an existing Sweep receipt;
- a `scope` display mode;
- a small `gates` / `detectors` query;
- a registered forensic table;
- a reusable render;
- an option on an existing command;
- a proper LAB operation when the concept is genuinely distinct.

Prefer the smallest surface that makes the capability discoverable and repeatable.

## Acceptance

The best evidence that this skill is working is not "zero scripts ever."

It is:

- repeated diagnostic work migrates into LAB;
- a fresh agent can discover the capability from help;
- the next investigation gets cheaper;
- private scripts do not become a shadow CLI.
