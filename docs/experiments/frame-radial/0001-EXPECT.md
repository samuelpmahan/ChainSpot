# Patch 0001 — Restore executable object-perimeter base

## Why
The task branch intentionally starts from `experiment/object-perimeters-v1`, whose checked-in source has two trivial typos and one decomposed-operation plumbing omission discovered by the local Experiment 1 replay.

## Expected change
- `componentAssembly.ts`: `conts` → `counts`.
- `objects.ts`: `measurent` → `measurement`.
- `badgeStage.components` retains same-stage dark labels/components and carries them into `BadgeStageResult`.

## What must NOT change
- Detector thresholds, recovery behavior, object assembly semantics, or V1 refusal policy.
- No new experiment abstractions yet.

## Verify before continuing
Native TypeScript compile should pass. On Dashs through G4, object-perimeter acquisition should remain behaviorally identical to the known probe: exact ownership when assembled, loud failure when not.

## Historical note
This patch is prerequisite plumbing only. Do not infer any scientific result from it.
