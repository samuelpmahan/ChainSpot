# CHSPT-65 — Carry completed course + thrown-round inputs into Create Graphics

## Goal

Make the fresh-course path carry the completed course annotation plus distinct clean-map and thrown-round source inputs into Create Graphics, so registration against a clean target can begin without losing or re-importing round context.

This task establishes the cross-route/input data flow only. It does not register the thrown-round graphics onto the clean target.

## Required behavior

- Stitch Map can preserve two semantically distinct source roles when both are supplied:
  - the clean course/map source;
  - the thrown-round source containing the played-round graphics.
- Those roles remain distinguishable through the subsequent workflow; neither may silently replace the other.
- The thrown-round source survives through Annotate Course completion and is still available when Create Graphics is reached.
- Completing Annotate Course (currently the 18/18 completion state) offers the user a direct continuation to Create Graphics.
- That continuation bypasses Map Round for this path without deleting or redesigning the Map Round route.
- Create Graphics receives the completed annotated course plus both source roles when present.
- For this incoming flow, Create Graphics presents Fetch Clean Target before the user proceeds into correspondence placement/registration.
- After the clean target is established, the existing course-source correspondence/registration workflow remains available.
- Preserve Create Graphics' existing soft boundary where it can still accept a direct image upload without an AnnotatedRound unless repo reality requires a narrowly scoped compatibility adjustment.

## Non-goals

- Do not remove or substantially redesign Map Round.
- Do not implement CV-based clean-vs-thrown image classification here. Automatic recognition based on the purple thrown path belongs in a separate ticket.
- Do not map/register the thrown-round graphics onto the clean target in this task.
- Do not implement Course Memory lookup/reuse behavior.
- Do not redesign the existing correspondence/transform system.
- Do not implement or polish final per-hole graphic generation/export.
- Do not broaden this into a general project-state or persistence redesign unless executable repo state makes the approved behavior impossible; surface such a conflict first.

## Known context

- ChainSpot is a browser-only SvelteKit app. Cross-route live state currently survives client-side navigation via `src/lib/session.ts`.
- `/annotate-course` and `/map-round` are thin routes over the shared `AnnotationWorkspace.svelte`, parameterized by mode. Each stage currently has its own independent in-memory editor key.
- Both annotation routes currently produce an `AnnotatedRound` artifact consumed by Create Graphics through `src/lib/session.ts`.
- Create Graphics also supports direct image upload with no `AnnotatedRound`; that existing behavior is a compatibility boundary worth preserving.
- Course annotation is conceptually one-time course setup; thrown-round imagery is per-round input. This ticket aligns the data flow with that distinction without yet implementing the thrown-round transform.
- Product-level acceptance and scope are owned by Linear CHSPT-65. If repo reality materially contradicts an assumption here, report it rather than silently redesigning the task.

## Acceptance

- A user can supply both a clean map/course source and a thrown-round source and the application keeps the two roles distinct.
- The thrown-round source is still available after completing Annotate Course and navigating to Create Graphics.
- At Annotate Course completion, the user can choose to continue directly to Create Graphics.
- The Map Round route remains present and is not required in this fresh-course path.
- Create Graphics receives the completed annotated course and both source-image roles when supplied.
- Fetch Clean Target is encountered before correspondence placement for this incoming path.
- Once a clean target is established, the existing course-source correspondence/registration interaction remains usable.
- Existing direct-upload Create Graphics behavior is not unintentionally broken.
- No thrown-round registration or automatic purple-path classification is introduced as part of this task.

## Proof Plan

- **Highest-value invariant — role separation and end-to-end ownership.** The thrown-round source remains semantically distinct from the clean course source from Stitch Map intake through Create Graphics. The chosen implementation uses its own long-lived `session.ts` slot, but the invariant is the product one: neither role can silently replace the other. Unit-test the session set/get/replace/clear semantics and independence from `setPendingHandoff`; verify Stitch Map writes the clean source and thrown-round source into the correct roles (clean source via the existing, unit-covered `source-overview` handoff path; the thrown-round write is a two-line handler over the tested slot, verified in the manual walkthrough — no unit test currently mounts the Stitch Map page and synthesizing a full stitch result in jsdom would be new, brittle infrastructure); and verify Create Graphics reads/retains the thrown-round role without substituting it for the clean-source / `AnnotatedRound` handoff.
- **Key regression test — completion handoff, course-length-aware.** Extend `annotateCourseSidebar.test.ts`'s course-complete-panel coverage so that when the configured course is complete, the panel offers Continue to Create Graphics and drives the existing `handleDone` path (pending `AnnotatedRound` set, navigation to `/create-graphics`), with Save course to memory and Map a round on this course present and unchanged. Repo reality: arbitrary-hole completion has NOT landed — the guided sidebar hard-codes 18 (`allHolesConfirmed === 18`), so a 9-hole course can never complete today. Per the approved revision, add a minimal 9-or-18 course-length choice and regression coverage for a completed 9/9 course alongside the existing 18/18 case; 18/18 is no longer assumed to be the only completion state.
- **Create Graphics ordering.** Unit-test, using the existing injected-editor pattern from `registrationPreview.test.ts`, that when the editor contains annotated holes but no committed `target-basemap`, the Fetch Clean Target section appears before the correspondence panes in DOM order; with no holes / direct-upload entry, the existing order and behavior are preserved. Also cover that a present thrown-round source does not alter or replace the course-source registration input (the source pane still receives the `AnnotatedRound` image with the thrown round present).
- **Automated-test limitation + manual proof.** jsdom tests cannot prove in-memory state survives real SPA navigation across Stitch Map → Annotate Course → Create Graphics, nor fully prove browser-rendered interaction/order. Perform a real browser/dev-server walkthrough of the cross-route handoff and report it as manual verification — explicitly checking: clean course source survives; thrown-round source survives independently; completed course annotation survives; Create Graphics receives the expected state; Fetch Clean Target is encountered before correspondence work; Map Round is bypassed for this path but remains available elsewhere. Unit tests are not claimed to prove this. E2E remains optional unless it becomes the highest-value proof. Environment limitation discovered at baseline: six pre-existing AnnotationWorkspace pointer-interaction suites (incl. `annotateCourseSidebar.test.ts`) fail on clean `main`/HEAD in this remote container before any CHSPT-65 change (44 failures, verified via stash runs); they reportedly pass in the maintainer's environment, so completion-handoff regressions added there are validated by construction against the surrounding passing patterns and flagged for reviewer re-run locally.
- **Nearby regression risk.** Particular attention to: Stitch Map's existing single-pending-handoff behavior; Create Graphics mount-time intake of handoff + pending round + badges + direct upload; the Annotate Course completion panel; the existing Map Round path; direct-upload compatibility in Create Graphics; and course-length assumptions embedded in completion logic (the guided sidebar's fixed 1–18 loops). Run `npm run check` plus the relevant existing Stitch Map, Annotate Course, Create Graphics, and session unit suites, modifying tests only to add the regressions above.
