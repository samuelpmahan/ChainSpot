# CHSPT-70 — Port Toph-attributed P1 corpus tuning + 0-bend prior into staging/vision

Linear: https://linear.app/chainspot/issue/CHSPT-70

## Goal

Port the 2026-08-17 corpus-tuning experiment on `claude/disc-golf-course-research-0nqf8j`
(commit `6785064`) onto `staging/vision`: keep the hand-rolled Toph trace slice
(source-side, not the `samuelpmahan/toph` library), flip the tuned P1 thresholds
to active defaults, wire the new 0-bend badge-on-chord shortcut into the pancake
stack, and carry a repeatable corpus-gate harness.

## Required behavior

1. `src/lib/toph/trace.ts` (Trace interface + NOOP) and the instrumented
   `rawObjectMask.ts` (every P1 gate a named Toph check, thresholds in
   `RAW_MASK_TUNING_DEFAULTS`) land unchanged in shape from `6785064`.
   `scripts/toph/record.ts`, `scripts/toph-run.ts`, `scripts/toph-tune.ts`,
   `scripts/toph-measure-zerobend.ts`, and the findings doc land as-is.
2. `RAW_MASK_TUNING_DEFAULTS` active values become: `basketPoolExcludeInsideBadgeMarginFrac
   0.08`, `teeAreaVsBasketMin 0.06`, `basketPoolFillMin 0.26`,
   `teeMinDimBadgeHeightFrac 0.30`. The historical values stay reachable as a
   named comparison config in `scripts/toph-tune.ts`.
3. A pure geometric predicate for the 0-bend badge-on-chord prior (badge
   perpendicular distance to the tee→basket chord ≤ ~3px at t∈[0.4,0.6]) is
   wired into the P3/P6 pancake stack as a pre-ribbon-evidence shortcut for
   confirmed straight (tee, basket, badge) triples.
4. `scripts/toph-run.ts` / `toph-tune.ts` / `toph-measure-zerobend.ts` are
   joined by one repeatable corpus-gate command (script + README) that
   reproduces the 4-course table, fetching images from `chainspot-corpus` dev/Annotated
   via LFS media URLs with sha256 verification against the LFS pointers.

## Non-goals

- Do NOT adopt `samuelpmahan/toph` as a dependency. It is reference-only;
  `codex/toph-productization` @ `80e1958` and its
  `examples/chainspot-p1-tee-geometry/rawObjectMask.patch` inform review only.
- Do NOT relax Heritage's rooftop-FP protection gates (grey-interior /
  appearance) chasing the remaining ~10 tee losses.
- Do NOT route `toph-slice-feedback.md` anywhere in this repo (separate repo).
- Do NOT touch `main`, staging deployment config, or production.

## Known context

- Zero drift: `origin/main` is exactly `6785064~1` — W1 is a clean cherry-pick,
  not a real merge, with `rawObjectMask.ts` as the only nontrivial surface.
- Corpus: `samuelpmahan/chainspot-corpus` `dev/Annotated/{DashsTrack,Heritage,Lenard,TowneLake}`.
  Images are Git LFS; fetch via `https://media.githubusercontent.com/media/samuelpmahan/chainspot-corpus/main/<path>`
  and verify sha256 against the LFS pointer's `oid`. AlexClark is deliberately excluded.
- Reference prior art (read-only): `samuelpmahan/toph` default branch (merge
  `2d87114`), `examples/chainspot-p1-tee-geometry/rawObjectMask.patch` —
  instruments only the 7-condition tee-geometry filter via compiler directives
  against an older ChainSpot commit (`2e327e7`); same gate order as the
  hand-rolled slice's `t.range`/`t.gte`/`t.lte` calls in `teeComponents`
  filtering. Useful cross-check, not a merge source.
- Trace artifacts (per-truth first-loss JSONs, masks/labelmaps, sweep + 0-bend
  measurements) live on toph branch `data/chainspot-p1-corpus-traces-2026-08-17`
  under `analysis/chainspot-p1-corpus-2026-08-17/` — cross-check worker claims
  against these during review without re-deriving.
- Pancake stack order: P1 `rawObjectMask.ts` → P2 badge labeling →
  P3 `rawObjectOwnership.ts` (`deriveP3Ownership`, tee-axis ray casting to
  badge then basket) → ribbon segmentation → P4 `p4RibbonOwnership.ts` →
  P5 `p5SparseAssignment.ts` → P6 `p6LowParBasketAssignment.ts`
  (`deriveP6LowParBasketAssignment`; `p4Locks` already shows the precedent
  for a pre-ribbon-evidence "certain, skip the Hungarian solve" lock — the
  0-bend shortcut's natural wiring point is a parallel lock computed before
  `ribbonSegmentation`/`evidenceGrid`-based LowPar scoring is consulted).
- `scripts/pancake-harness.ts` accepts either a `.chainspot.zip` OR a raw
  image path directly (no zip fixture needed for DashsTrack — pass the fetched
  JPEG straight in).
- `RAW_MASK_TUNING_DEFAULTS`/`detectRawObjectMask` signature
  (`raster, trace?, tuning?`) must stay backward compatible: production
  callers (`basketDetection.worker.ts`) pass neither and must see the new
  active-default *behavior* (this is the point of W2) but zero new required
  params.

## Detection vs. association — do not conflate

This port has two structurally different kinds of "18/18" and they must never
be reported, or reasoned about, as one number:

- **Detection/localization recall** (`scripts/toph-tune.ts`, the "corpus
  table"): for each ground-truth tee/basket POINT, is there SOME emitted P1
  object within tolerance anywhere in the image? It does not look at hole
  numbers at all. It cannot tell "hole 3's tee and hole 5's tee got swapped"
  from "both correct" — both look like 2/2 detected. This metric lives
  entirely inside P1 (`rawObjectMask.ts`) and is therefore, by construction,
  **blind to P3/P6** — it can sanity-check that W3 didn't accidentally touch
  P1, but it can never prove or disprove W3's actual behavior.
- **Association/assignment correctness** (`scripts/pancake-harness.ts`,
  matched by hole NUMBER against the annotation truth): does hole N's
  FULL-PIPELINE (P1→P6) assigned tee/basket land within tolerance of hole N's
  own truth point? This is the only metric that can validate P3–P6 changes,
  including W3's shortcut, because it's the only one that checks the pairing
  is attached to the right hole, not just present somewhere.

**Known tooling gap (found during lead verification, not a regression):**
`pancake-harness.ts` does not reproduce ChainSpot's intake autocrop the way
`toph-run.ts`/`toph-tune.ts` do (`autocropLikeIntake`). Feeding Heritage,
Lenard, or TowneLake's raw un-autocropped images directly into
`pancake-harness.ts` produces ~400–530px per-hole errors — a frame-offset
artifact, not a real detection/association failure (confirmed by the lead:
DashsTrack needs no autocrop and is unaffected; the other three do and are
not usable with this harness as-is). Per-hole association verification in
this ticket is therefore intentionally scoped to **DashsTrack only**, which
is exactly what the ticket's own acceptance criteria already say — do not
read "corpus table 58/72 tees" as if it were an association claim about all
four courses, and do not have W4 attempt full-pipeline per-hole checks on
Heritage/Lenard/TowneLake without first fixing this gap (out of scope here;
note it in the corpus-gate README as a known limitation instead of silently
producing, or silently avoiding, misleading numbers).

When reporting verification results anywhere (Review Brief,
`CHANGELOG-dev.md`, worker reports back to the lead), state these two
numbers under clearly separate labels — never merge them into one blanket
"18/18 verified" claim.

## Acceptance

- `npx tsx scripts/toph-tune.ts <imagesDir> <corpus>/dev/Annotated` →
  tees ≥58/72, baskets ≥67/72, FPs ≤3, DashsTrack exactly t18/18 b18/18 +0.
- `npx tsx scripts/pancake-harness.ts <DashsTrack-full.jpg> .` → all 18
  holes' proposed tee AND basket within 26px of that hole's annotation truth
  (per-hole, not just overall "ready"); wall time within noise of `main`.
- `npm run check` clean; `npx vitest run tests/unit/rawObjectMaskGreyInterior.test.ts`
  plus any new W3 unit tests green.
- No import of `scripts/toph/record` reachable from anywhere under `src/`.
- W3 shortcut active must not regress corpus numbers vs. W2's tuned config —
  a regression is a first-class stop-and-report result, not something to tune
  around in the same run.
- E2E/browser tests skipped (AGENTS.md: skip unless a gate genuinely needs one).

## Proof Plan

_Lead's plan, written before any worker starts code — this is what "verified"
means for this port; workers are held to it, not to their own claims._

1. **Highest-value invariant to prove:** the ported+tuned P1 pass reproduces
   the tuned corpus table exactly (t58/72 b67/72 +3FP, DashsTrack t18/18
   b18/18 +0) *and* production behavior at defaults (no trace, no tuning
   override) is the new tuned behavior, not the old one — i.e. W2's flip
   actually reaches the code path real callers use.
2. **Regression test that would fail if wrong:** `scripts/toph-tune.ts` run
   against the real 4-course corpus (not trusted from a worker's transcript —
   re-run by the lead after every merged unit) is the load-bearing gate; a
   wrong `RAW_MASK_TUNING_DEFAULTS` value, a badly-ported gate, or a
   regressed DashsTrack baseline all show up here first. `pancake-harness.ts`
   on DashsTrack is the second load-bearing gate — it is the only proof that
   the full pipeline (not just P1) still assigns every hole correctly end to
   end, and is the only gate that would catch a P3/P6 W3 regression.
3. **Real-browser/manual verification:** not required. This is a pure
   detection-pipeline change with no UI surface; `AGENTS.md` says skip E2E
   unless a gate genuinely needs one, and none here touches rendering,
   interaction, or persisted state.
4. **Nearby behavior at regression risk:** (a) any other P1 caller besides
   `basketDetection.worker.ts` that might pass its own tuning object and get
   silently different results than before; (b) `hasGreyInterior`/appearance
   gates that must NOT be touched by W2's tuning flip (Heritage rooftop-FP
   protection is explicitly out of scope); (c) P4/P5/P6 hole-assignment
   status codes — W3's new shortcut must not change the *shape* of existing
   result types in a way that breaks `pancakeCourseDisplay.ts` or worker
   message consumers; (d) NOOP trace path must stay truly zero-alloc/zero-cost
   on the code paths production actually runs (the experiment's own
   4.3%-slower finding was traced to the flood-fill labels branch, not gate
   calls — confirm nothing in the port regresses that further).
5. **Limits of automated proof:** `npm run check` and unit tests prove types
   and isolated function behavior, not that the tuned thresholds are
   correct on courses outside the 4-course corpus — the findings doc's own
   "small-N honesty" section applies unchanged after the port. Wall-clock
   timing checks in this container are noisy (shared CPU); "within noise of
   main" is a sanity bound, not a strict regression gate.
