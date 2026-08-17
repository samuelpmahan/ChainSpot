# CHSPT-35 — Produce one correct editable throw route from a real round

## Goal

Turn the already-demonstrated landing-droplet detector into correctable played-round proposals that a user can assign, reorder, edit, accept, and hand to Create Graphics through the existing production round model.

## Required behavior

- Consume a thrown-round source plus a usable played-to-clean registration and known course geometry.
- Run the existing real-fixture-proven landing detector as a proposal generator, not authoritative truth.
- Let the operator correct hole assignment, landing location, and explicit shot order without restarting.
- Preserve proposal evidence only in review state; accepted data becomes existing authoritative `AnnotatedHole.shots` semantics.
- Deliver the corrected route through `AnnotatedRound`, `ProjectEditor`, and Create Graphics.

## Non-goals

- New general CV architecture or indefinite renderer/compositing research.
- Automatic walking-path productionization without broader evidence.
- Irreversible automatic hole/order assignment.
- Broadcast graphic visual design or Gate 3 work.

## Known context

- The production detector CLI reproduces 4/4 droplets with zero deferred overlaps on `resources/real-capture/ReferenceStitch.png`.
- `AnnotatedHole.shots` array order is authoritative shot order and already persists/renders in that order.
- Current Map Round supports append, move, and remove, but lacks explicit shot reorder and shot-to-hole reassignment.
- The existing detector does not infer holes or order. Any automatic suggestion must remain correctable review state.
- Current `main` is `4da01fba601a250e2fd4e7b8683c9fdd6bf0401b`.
- This corrective candidate intentionally starts from unmerged `integration/demo@fd8b57f`; the proposal review UI and the reproduced state-integrity failures exist only on that integrated base.
- Browser review reproduced detection-time default-order snapshots inserting later accepts ahead of prior authoritative shots, and out-of-bounds reviewed coordinates reaching `ProjectEditor.setHoles` as uncaught domain errors.
- Rounded-coordinate proposal IDs can collide for distinct detector candidates. IDs must remain deterministic for the same detector result while also being unique within one proposal batch.

## Acceptance

- One real hole has a tee, at least two ordered landing points, and a basket in editable production semantics.
- A wrong suggested hole can be corrected without rerunning detection or registration.
- Landing positions and shot order are independently editable.
- Corrected data reaches Create Graphics through the production `AnnotatedRound` handoff.
- Browser proof verifies exported route geometry follows the corrected ordering.

## Proof Plan

- Reproduce the real landing fixture through the detector CLI and preserve exact tips/classes as evidence.
- Unit-test proposal generation across a supplied registration, acceptance into existing shots, stable-ID reorder, and cross-hole reassignment.
- Add browser coverage that starts with a wrong assignment/order, corrects both, and proves Create Graphics consumes the corrected sequence.
- Re-run focused persistence, annotated-round receipt, hole-graphics ordering, and Map Round interaction coverage.
- Keep detection confidence/provenance out of accepted `AnnotatedRound`; test that conversion boundary directly.
- Prove each untouched order draft appends against the authoritative shot count at acceptance time, while an operator-edited order is honored even after earlier proposals are accepted.
- Prove non-finite and out-of-clean-image coordinates disable acceptance with actionable inline feedback, and catch any downstream domain rejection without losing the proposal.
- Prove distinct candidates with the same rounded coordinates receive collision-safe IDs that are stable across repeated conversion of the same ordered detector output.
