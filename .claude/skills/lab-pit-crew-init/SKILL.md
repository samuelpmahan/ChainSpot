---
name: lab-pit-crew-init
description: >
  Initialize a local ChainSpot LAB pit-crew workspace for a bounded multi-agent
  investigation. Establish storage on a large-capacity non-system drive, verify
  repository/ref custody, prepare one stable LAB control checkout and one writable
  implementor worktree, and report the resulting paths and SHAs. Use before
  launching separate Front Door, Operator, Implementor, and Review contexts.
---

# LAB Pit Crew Init

Prepare the local filesystem and Git topology for a LAB pit crew.

This skill initializes infrastructure only.

It does not investigate the task, implement changes, run experiments, define the
experiment plan, or launch agents.

## Required topology

A pit crew has:

- one **control checkout** used for LAB operation and read-only inspection;
- one **implementor worktree** where source changes may occur;
- shared artifact space outside the implementor worktree.

Separate agent/chat roles do not receive separate worktrees.

Only the implementor lane edits repository source.

## 1. Storage guard

Pit-crew working data must live on a large-capacity non-system drive when the user
has requested one.

Before creating or moving substantial data:

1. inspect available volumes/mounts;
2. identify the requested large-capacity storage by actual filesystem backing and
   free space;
3. resolve the proposed pit root to an absolute path;
4. verify that it is not backed by the constrained system/SSD volume;
5. report the resolved volume and available space.

Do not infer physical storage from a path name alone.

Pay particular attention to:

- WSL mounts;
- Docker-backed filesystems;
- symlinks;
- junctions;
- bind mounts;
- system temp directories.

If physical backing is ambiguous, stop rather than placing a large workspace on
the wrong drive.

Never silently fall back to the home directory or system drive.

## 2. Establish repository custody

Repository state must be observed, not remembered.

Before initialization:

- fetch/inspect the requested repository;
- resolve every ref supplied by the invoking task to its current SHA;
- inspect existing relevant clones/worktrees;
- report dirty state rather than destroying it;
- distinguish the current development ref from the requested experimental/control
  ref.

A newer branch HEAD does not automatically replace an explicitly requested
experimental baseline.

Do not choose the baseline yourself when the invoking task has not made it
unambiguous.

## 3. Prepare the pit root

Use a structure equivalent to:

```text
<PIT_ROOT>/
├── control/
├── worktrees/
│   └── implementor/
└── artifacts/
```

Reuse an existing safe pit root when appropriate rather than multiplying clones.

## 4. Control checkout

`control/` is the stable LAB-operating checkout.

Requirements:

- exact requested control SHA/ref;
- clean source/config/test state at initialization;
- working repository remotes;
- usable dependencies/build environment;
- LAB entry point can be invoked.

Normal generated LAB/build artifacts are permitted.

Do not perform candidate source edits in `control/`.

Do not automatically advance `control/` when another branch changes.

If `control/` already exists and contains user source changes, stop and report them.
Never reset them away.

## 5. Implementor worktree

Create or reuse exactly one writable worktree:

```text
<PIT_ROOT>/worktrees/implementor
```

Requirements:

- based on the control/candidate parent specified by the invoking task;
- clean at handoff;
- on a clearly identified implementation branch;
- located on the same approved large-capacity storage.

This is the only pit-crew workspace intended for repository source/config/test
changes.

Do not create worktrees for:

- Front Door;
- LAB Operator;
- receipt/visual reviewer;
- individual implementation subagents.

Multiple implementation agents coordinate inside the one implementation lane unless
the invoking task explicitly requests a different topology.

## 6. Artifact location

Provide an HDD-backed artifact root suitable for:

- Sweep outputs;
- VisualRenders;
- machine receipts;
- temporary comparison artifacts;
- review artifacts.

Do not intentionally place large generated evidence on the constrained system
drive.

If LAB itself insists on writing some generated data inside its checkout, report
that fact rather than pretending all outputs were relocated.

## 7. No role-policy invention

This skill may report which filesystem location corresponds to:

- control/LAB operation;
- implementation;
- shared artifacts.

It does not define the mission-specific behavior of the agents using them.

The invoking launch prompt owns:

- objective;
- baseline meaning;
- experiment queue;
- role briefs;
- acceptance criteria;
- receipt requirements;
- VisualRender requirements;
- implementation scope;
- model assignments;
- escalation rules.

## 8. Completion receipt

Initialization ends with a compact machine/human-readable receipt:

```text
LAB PIT CREW READY

STORAGE
  root: <absolute path>
  backing volume: <volume>
  free: <space>

CONTROL
  path: <absolute path>
  ref: <requested ref>
  HEAD: <sha>
  status: clean
  LAB: runnable

IMPLEMENTOR
  path: <absolute path>
  parent: <sha>
  branch: <branch>
  status: clean

ARTIFACTS
  path: <absolute path>
```

If initialization cannot prove one of those facts, print:

```text
LAB PIT CREW NOT READY
```

with the exact blocker.

## Boundaries

Do not:

- investigate the actual algorithm problem;
- run the experiment suite merely because initialization succeeded;
- modify algorithm source;
- modify experimental configuration;
- choose among scientific hypotheses;
- create role-specific worktrees;
- merge candidate work;
- move the control baseline;
- create a generalized AutoScience/case-management system;
- encode task-specific receipt or VisualRender requirements into this skill.

The result of this skill is simply:

> a known-safe place for a pit crew to work.
