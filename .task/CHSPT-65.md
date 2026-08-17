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

- **Highest-value invariant — role separation.** The thrown-round source rides its own long-lived `session.ts` slot, structurally separate from the clean-source `pendingHandoff` / `AnnotatedRound` path, so neither role can silently replace the other. Unit-test the new slot's set/get/replace/clear semantics and its independence from `setPendingHandoff` (`tests/unit`, new session test).
- **Key regression test — completion handoff.** Extend `annotateCourseSidebar.test.ts`'s existing course-complete-panel coverage: at 18/18 the panel offers a "Continue to Create Graphics" action that drives the existing `handleDone` path (pending `AnnotatedRound` set, navigation to `/create-graphics`), while "Save course to memory" and "Map a round on this course" remain present and unchanged.
- **Create Graphics ordering.** Unit-test (page mount with injected editor, pattern from `registrationPreview.test.ts`) that when the editor holds annotated holes but no committed `target-basemap`, the Fetch Clean Target section renders before the correspondence panes in DOM order, and that with no holes (the direct-upload entry) the existing order is unchanged.
- **Automated-test limitation + manual proof.** jsdom unit tests cannot prove the in-memory thrown-round slot survives real SPA navigation Stitch Map → Annotate Course → Create Graphics, nor the browser-rendered visual order; per repo rules this cross-route handoff is flagged for manual browser verification (dev server walk-through) rather than claimed proven by unit tests. E2E is skipped unless it becomes the highest-value proof.
- **Nearby regression risk.** Stitch Map's single-pending-handoff guard, Create Graphics' mount-time intake (handoff + pending round + badges + direct upload), and the completion panel's existing Map Round path. Guard: run `npm run check` plus the existing stitch-map, annotate-course, and create-graphics unit suites unmodified except for the additions above.
