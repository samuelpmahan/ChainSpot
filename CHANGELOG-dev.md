# ChainSpot dev changelog

One line per landed feature. Condensed/reset periodically; Git history keeps
prior contents.

## 2026-08-17 — CHSPT-70: Toph-attributed P1 corpus tuning + 0-bend prior

- P1 (`rawObjectMask.ts`): every gate is now a named Toph trace check
  (`src/lib/toph/trace.ts` NOOP in production, recorder in `scripts/toph/`,
  never imported from `src/`); all thresholds live in `RAW_MASK_TUNING_DEFAULTS`
- P1 active defaults flipped to the tuned 4-course-corpus config
  (`basketPoolExcludeInsideBadgeMarginFrac 0.08`, `teeAreaVsBasketMin 0.06`,
  `basketPoolFillMin 0.26`, `teeMinDimBadgeHeightFrac 0.30`); old values stay
  reachable as the `historical` preset in `scripts/toph-tune.ts`
- P3/P6: new 0-bend badge-on-chord shortcut (`zeroBendChord.ts`,
  `computeZeroBendLocks` in `p6LowParBasketAssignment.ts`) — a straight
  (tee, basket, badge) triple with its badge ≤3px off the tee→basket chord
  at t∈[0.4,0.6] locks before ribbon evidence is consulted, same treatment
  as an existing P4 lock; ambiguous (0 or 2+ qualifying baskets) never locks
- New `scripts/toph-corpus-gate.ts` + `.md`: one command fetches and
  sha256-verifies the 4 in-scope `chainspot-corpus` course images (LFS media
  URLs, AlexClark excluded) and reproduces the corpus table as a CI-less
  regression gate; optional `--with-association` runs the DashsTrack-only
  full-pipeline hole-matched check
- Docs: `pancake-harness.ts` now documents that it doesn't reproduce intake
  autocrop (safe on DashsTrack only, not raw Heritage/Lenard/TowneLake)
- Unchanged: production behavior for any caller that already passed no
  `trace`/`tuning` args gets the new tuned behavior automatically; no new
  required parameters anywhere in the changed signatures

Verified: 4-course P1 detection recall (`toph-tune.ts`, tolerance 26px) —
tees 18→**58**/72, baskets 51→**67**/72, FPs 17→**+3**, DashsTrack exactly
t18/18 b18/18 +0 in every config. Full-pipeline association (`pancake-harness.ts`,
matched by hole number — **only meaningful metric this port has for P3–P6**,
since the corpus table is P1 detection-only and blind to hole assignment) —
DashsTrack 18/18 tees AND baskets within 26px, max deviation 4.17px, zero
`unresolved`; the 0-bend shortcut fired exactly once (hole 16, a straight hole
not already P4-locked) and resolved it correctly with no ribbon evidence
available for that triple (confirmed via a dedicated integration test).
Heritage/Lenard/TowneLake have no full-pipeline association check in this
port — `pancake-harness.ts` doesn't reproduce intake autocrop, so raw corpus
images for those three produce frame-mismatch garbage, not a real signal;
documented as a known tooling gap, not fixed here. `npm run check` clean;
`rawObjectMaskGreyInterior` + new `zeroBendChord` unit suites green (17
tests); no import of `scripts/toph/record` reachable from `src/`. Six
pointer/annotation-UI test suites red at clean `origin/main` in this
container — pre-existing per CHSPT-65's entry, confirmed unrelated by diffing
against a clean worktree, untouched by this port. E2E/browser tests skipped
per AGENTS.md (no UI surface changed). `samuelpmahan/toph` was not adopted as
a dependency (reference-only, per ticket scope); Heritage's remaining ~10 tee
losses behind rooftop-FP protection gates were not touched (explicitly out of
scope).

## 2026-08-17 — CHSPT-65: course + thrown-round inputs into Create Graphics

- Stitch Map: import prompt with thumbnails — pick the thrown round BEFORE any crop/stitch
- Stitch Map: "Thrown round" button on each loaded tile slot
- Stitch Map: pick the thrown round from a stitched result (clean map re-stitches without it)
- Stitch Map: "Keep as thrown round" for a single-capture result
- Stitch Map: persistent held-round banner with Discard
- Session: thrown-round slot, distinct from clean-source handoff, survives into Create Graphics
- Session: stale thrown round auto-cleared when a new course workflow starts
- Annotate Course: completion panel button "Continue to Create Graphics" (skips Map Round)
- Annotate Course: Holes selector 9/18 — 9-hole courses can now complete
- Annotate Course: completion blocked if confirmed holes exist beyond selected length
- Annotate Course: CV detection auto-selects 9 when all evidence is in holes 1–9
- Create Graphics: banner showing the carried thrown round
- Create Graphics: Fetch Clean Target moves above the panes until a clean target is committed
- Unchanged: Map Round route, direct image upload, correspondence/registration flow

Verified: `npm run check`; unit suites `thrownRoundFlow` + `annotateCourseCompletionHandoff`;
26/26 scripted Chromium checks; independent review addressed; staged for manual acceptance.
No unit coverage for detection→9 (needs real Worker). Six pointer-test suites red at clean
HEAD in the work container — pre-existing, unrelated.
