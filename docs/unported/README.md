# Unported Knowledge — ChainSpot

## What this directory is

Between 2026-08-17 and 2026-08-24 a large amount of ChainSpot algorithm work accumulated on branches in the **old** repository at `C:/Users/tenni/workspace/ChainSpot`. On 2026-08-17 (commit `4da01fb`) the project forked into a rebuild at `D:/LAB/ChainSpot` with a completely different tree layout — `src/lib/detectors/threeFactor/` became `packages/alg/src/detectors/threeFactor/`, and effectively every file moved. That means **none of those branches can ever be merged**: git sees deletes and adds, not edits, and a merge would produce garbage. Rather than hand-porting code that was written against the old contract anyway, we made a deliberate choice to **abandon the code and keep the knowledge**. Ten extractors read the old branches read-only and wrote down, in prose, what each piece of work detects, why it exists, what pixels it looks at, every magic number it depends on, and what evidence (if any) proves it works. Each spec in this directory is a rebuild instruction, not a port: someone should be able to regenerate the behavior under the new ABFeature contract without ever opening the original source. The old repo stays read-only forever; when this machine is reset, these files are what survives.

**Two things this project believes, which every spec here honors:**

- Thresholds are dataset-fit estimates, not physics. They are the first suspect when a gate misbehaves. Where a derivation could not be recovered, the spec says **UNKNOWN** loudly. Section 4 collects every one of them.
- Every claimed accuracy number ships with a rendered evidence image. Most numbers in these specs **do not have one**. Those numbers are marked as claims, not facts.

**The named catastrophe.** A trophy-shaped basket sprite gets a *square* bounding box. That square swallows a nearby tee pad. An inspector sees "no tee here", concludes the tee detector is broken, and deletes correct code. Several specs below carry live instances of this exact failure family (G2 area-vs-bbox denominators, the G3 badge-inset sign conflict, materialMap badge contamination, the localSnap crop-vs-radius asymmetry). They are flagged in Section 5.

---

## 2. The specs

| Spec file | Branches (old repo) | Verdict | One-line summary |
|---|---|---|---|
| [`engine-dev72-lineage.md`](engine-dev72-lineage.md) | `engine/dev72`, `integration/claude-t1-t6`, `lab/dev72-algorithm` | partially worth it | The T1–T6 spine: artifact renderers, canonical G0 intake, rejection testimony, experiment expansion, receipts — the platform everything else reports through. |
| [`lab-render-evidence.md`](lab-render-evidence.md) | `lab/render-evidence` | **discard** | Strict subset of `engine/dev72`; its only unique value is the mask 0/1→0/255 display fix, which exists on dev72 too. |
| [`uncommitted-work.md`](uncommitted-work.md) | `integration/claude-t1-t6`, `demo/mock-engine`, `codex/ab-local-snap-clickfix` (all **dirty, nothing committed**) | partially worth it | Never-committed work: the mask render fix, the guided human-review reducer with explicit skips, multi-bend support, and a localSnap A/B whose OFF arm is the trophy-basket trap in miniature. |
| [`g3-intact-tee-family.md`](g3-intact-tee-family.md) | `codex/ab-g3-intact-tee-family` (donor `codex/ab-g3-tee-family`), LAB `codex/three-factor-dev72-lab` | partially worth it | Finds the bright frame enclosing each tee ring, keeps only the largest family of tees whose frames agree on size, and explains every drop. |
| [`g2-clean-basket-family.md`](g2-clean-basket-family.md) | `codex/ab-g2-clean-basket-family` (the pushed remote tip is a **diverged decoy**) | partially worth it | Accepts a basket only if a bright component matches the 42×66 sprite template on area, shape-local white coverage, and dark-shell evidence; rejection currently *deletes*, which is dangerous. |
| [`fourlane-sensor-cluster.md`](fourlane-sensor-cluster.md) | `codex/ab-tbs-ribbon-primitives` (base), `codex/ab-tbs-orient-rails`, `codex/ab-tbs-course-width` | partially worth it | Four-lane corridor cross-section sensor with strict occlusion-as-UNKNOWN discipline, course-local width calibration, and a 24-angle rail sweep. |
| [`tbs-primitives.md`](tbs-primitives.md) | `codex/ab-tbs-badge-transit`, `codex/ab-tbs-min-required-run` | partially worth it | Two small tracker primitives: coast blindly through a known badge without counting hidden pixels as failure, and require a minimum contiguous run of qualified samples. |
| [`tbs-material-and-residual.md`](tbs-material-and-residual.md) | `codex/ab-tbs-material-map`, `codex/ab-tbs-composite-residual` | partially worth it | Two course-local "what does corridor material look like here" models (gray+chroma log-odds histogram; per-channel affine outside→inside residual). Neither is wired to anything. |
| [`refactor-separation-of-concerns.md`](refactor-separation-of-concerns.md) | `refactor/separation-of-concerns` (26 commits, never pushed) | partially worth it | Architecture ratchet, zone rules, and a semantic-vs-evidence firewall in the domain types; the campaign stopped mid-way and never ran its own required proofs. |
| [`dsh-fountain-hills.md`](dsh-fountain-hills.md) | `dsh/fountain-hills-pro-20260818` (configured upstream deleted) | partially worth it | A Python middle-out experiment: route each hole outward from the badge in two independent legs over a color-agnostic paired-edge field. **All outputs and all inputs were gitignored and are gone.** |

---

## 3. Regeneration order

Work top to bottom. Each step's clause says why it must come before the ones under it.

| # | Do this | Because |
|---|---|---|
| 1 | **Honest evidence rendering** — mask 0/1→0/255 scale, and replace the `summary.endsWith('stub only')` string sniff with a typed outcome on `RendererOutput` (`engine-dev72-lineage`, `uncommitted-work`) | every number produced below is unbelievable until the evidence images are legible and the "N rendered" count stops lying. |
| 2 | **Canonical G0 intake, `rasterDims` plumbing, coordinate-frame discipline** (`engine-dev72-lineage` T6, `uncommitted-work` groundcheck) | every downstream coordinate claim is meaningless until raw→crop→canonical frames and the `viewport.topPx` seam are pinned once, centrally. |
| 3 | **Rejection testimony / no-silent-drops trace** (`engine-dev72-lineage` T2+T3, plus the unported G3 deltas 46ecd75 and 936a6be) | you cannot tune, or even argue about, a gate that answers "0 tees" without saying which predicate killed which candidate. |
| 4 | **Threshold measurement harness** (the `familyTuning` harvest + histogram render from `codex/heritage-g3-threshold-audit`, plus a ruling on `ASSOCIATION_TOLERANCE_PX`) | Section 4 is roughly ninety unexplained numbers; build the instrument before touching any of them, or the rebuild inherits the same landmines. |
| 5 | **G3 endpoints badge-inside polarity** — settle LAB's −7px inset versus the engine's +3px pad | this one sign decision changes which tee rings exist at all, so nothing in G3 can be measured until it is fixed. |
| 6 | **G3 intact tee family** (`g3-intact-tee-family`) | depends on G1 badges and G3 endpoints being final (step 5) and on the trace contract (step 3) to be diagnosable at all. |
| 7 | **G2 clean basket family** (`g2-clean-basket-family`), after deciding demote-versus-delete | needs the sprite/basket seam and G3's tee-exclusion mask to already exist, because rejecting a basket punches a hole in that mask. |
| 8 | **Invent the ST pose/tracker seam on the evidence board** | all four ST specs below are explicitly blocked on a slot that does not exist; without it they are registered dead code that changes nothing when enabled. |
| 9 | **Four-lane corridor sensor + course-local width** (`fourlane-sensor-cluster`) | it is the base primitive every other ST piece samples through, and it owns the occlusion-as-UNKNOWN contract the rest inherit. |
| 10 | **Badge transit + minimum required run** (`tbs-primitives`) | both are modifiers *on* a tracker walking the sensor from step 9; neither means anything on its own. |
| 11 | **materialMap and compositeResidual** (`tbs-material-and-residual`) | both sample at fractions of the corridor width calibrated in step 9, and both need real badge geometry (steps 2 and 5) to stop training on badge pixels. |
| 12 | **Experiment expansion + receipts viewer** (`engine-dev72-lineage` T4/T5) | worth building only once there are enough real knobs and real evidence images to sweep and review. |
| 13 | **Architecture ratchet** (`refactor-separation-of-concerns`) | freezing a debt baseline only helps after the rebuild's file shapes stop moving; doing it now locks in today's mess. |
| 14 | **Middle-out routing probe** (`dsh-fountain-hills`) | a separate research line with zero surviving evidence; revisit only if threeFactor corridor recovery plateaus, and only after re-capturing inputs. |

**Outside the order, decide separately:** the localSnap clickfix A/B (`uncommitted-work`) is UI-side, and its default arm *reverts* behavior the rebuild already has — see Section 5, item 9.

---

## 4. Every UNKNOWN threshold, in one place

These are the landmines. **UNKNOWN** means no derivation, sweep, comment, test, or note explaining the value survives anywhere on either disk. Treat every one as a dataset-fit guess and the *first* suspect when its gate misbehaves.

### G1 / G3 endpoints and tee detection

| Name | Value / note |
|---|---|
| `holeAreaMin` | 10 |
| `holeAreaMax` | 480 |
| `holeDimMax` | 44 |
| `ringBand` | 3 |
| `ringFracMin` | 0.6 |
| `dilationRadii` | [0,1,2,3] — motivated ("5 of 9 dev tee misses"), but the exact set is not justified |
| `largeRadiiThreshold` | 2 — asserted, never measured |
| `largeRadiiAreaMin` | 40 |
| `ringMergeProximity` | 10 |
| `elongationThreshold` | 1.18 — decides tee-rect versus diamond, therefore decides which rings anything downstream ever sees |
| `componentMinDim` / `componentMaxDim` | 8 / 42 |
| `componentMinArea` / `componentMaxArea` | 80 / 350 |
| `componentMinFill` / `componentMaxFill` | 0.2 / 0.85 |
| `teeRingDedupDistance` | 12 — **not** the g4.scoring `ringTolerance`, which is coincidentally also 12 |
| `teeSpriteExclusionDistance` | 24 — **the live trophy-swallows-tee mechanism** |
| `badgeInsidePadding` | 3 — *grows* the badge bbox in `makeTees` |
| LAB `insideBadgeInterior` inset | 7 — *shrinks* the badge bbox; opposite sign to the above, 10px net swing per side |
| `frameAreaMin` / `frameAreaMax` | 10 / 500 |
| `frameMaxWidth` / `frameMaxHeight` | 50 / 50 — no matching minimum, so 1×1 blobs are eligible if area passes |
| `majorRatioToleranceFactor` | 1.25 |
| `minorRatioToleranceFactor` | 1.25 |
| `areaRatioToleranceFactor` | 1.5 — note it is *not* 1.25² = 1.5625, so not the product identity either |
| LAB gray band | 145 / 175 — **not ported and must stay unported**; it was `console.log` telemetry that never selected or rejected anything |

### G2 clean basket family

| Name | Value / note |
|---|---|
| `bboxTolerancePx` | 2 — also **inert** under default knobs; it only changes which rejection reason you read |
| `positionTolerancePx` | 2 — **not from the source at all**; invented by the port by analogy with the above |
| `areaRatioMin` / `areaRatioMax` | 0.96 / 1.03 — the −4% / +3% asymmetry is unexplained |
| `whiteCoverageMin` | 0.96 — coincidentally equals `areaRatioMin`; no evidence they are coupled, do **not** merge them |
| `shellRadiusPx` | 2 — doubles as dilation iteration count and scan-window padding |
| `darkShellMin` | 0.5 |
| `darkCoherenceMin` | 0.8 |
| unnamed inline constants | 8-neighbour connectivity, `'1'` as the template white marker, the `x:y` join key, 3-decimal reason formatting (tests assert on it, so it is load-bearing) |

*Structural, not UNKNOWN:* template 42×66 holding 1746 white pixels out of 2772 bbox pixels (63%) — that denominator is what keeps this feature out of the trophy trap.

### Four-lane corridor sensor cluster

| Name | Value / note |
|---|---|
| `edgeDeltaPx` | 2.5 — verbatim from Dev72 LAB, no sweep, no tuning record |
| `liftReference` | 45 — an absolute gray-level lift, **not** contrast-normalized |
| `tangentHalfPx` | 4 |
| `tangentSamples` | 5 — couples to the majority-blocked rule, so 3 blocked means UNKNOWN |
| guard normal offsets | ±2W/3 — "just outside the bundle"; why 2/3 and not 3/4 is unknown |
| inner sub-band offsets | ±laneWidth/3 |
| band occlusion rule | blocked×2 ≥ n (majority) |
| inner-lane occlusion rule | ≥2 of 3 sub-bands blocked |
| `orientationCount` | 24 — **specification-derived only**, from a prose study doc; no implementation producing it was ever located |
| `candidateWidthsPx` | [24,30,32,36,40,48,56,64] — irregular spacing (6,2,4,4,8,8,8) suggests accreted observations, not a designed grid |
| `sampleFractions` | [0.2,0.35,0.5,0.65,0.78] — **not symmetric**; 0.78 is probably a transcription typo for 0.8, preserved verbatim |
| course-width final fallback width | 40 — arbitrary last-resort literal when the candidate array is empty |
| orient-rails lift clamp | `min(1,lift)` with a strict `lift > 0` gate — **asymmetric** with the base sensor's `clamp01`, so a rail rendered darker than its surroundings scores nothing rather than low |

*Not UNKNOWN:* lane count 4, lane width W/3, lane offsets [−W/2, −W/6, +W/6, +W/2] — geometric identity, explicitly declared not tunable. Also the 1e-6 divide guard.

### Tracker primitives (badge transit, minimum run)

| Name | Value / note |
|---|---|
| `stepPx` | 6 — copied from frozen defaults; no sweep survives; long-term ownership is still unassigned |
| `extraLockSteps` | 1 — invented by the port to generalize a hard-coded `+ stepPx`; why one step and not two is unknown |
| `sampleSpacingPx` | 3 — "the experiment used 3px"; the raw producer was not found |
| `minRequiredRunPx` | 0 — **deliberately inert**; the useful value is unknown and must be swept |
| frozen four-lane constants never ported and never audited | `headingOffsetsDeg` [−18,−12,−6,0,6,12,18], `lookaheadSteps` 3, `maxDistancePx` 600, `failureSteps` 6, `minVisibleScore` 0.07, `maxUnknownSteps` 16 |

*Not UNKNOWN:* `EPSILON` 1e-9, a floating-point guard.

### materialMap and compositeResidual

| Name | Value / note |
|---|---|
| `materialMap.sampleStepPx` | 3 — versus compositeResidual's 4; nobody knows why they differ |
| `segmentStartPxFloor` | 12 |
| `segmentStartFraction` | 0.12 — suspiciously 12/100, possibly an artifact of tuning on ~100px segments |
| `segmentEndPxFloor` | 13 — literally `startPxFloor + 1`; looks like an empty-loop guard, now frozen by a test |
| `segmentEndFraction` | 0.80 — intent is "stop before the badge", but it is a fraction of *length*, not tied to the 48px badge width. **This is the badge-contamination bug.** |
| `grayBins` / `chromaBins` | 24 / 12 — bin counts were never swept |
| `chromaMax` | 128 — real chroma spans 0..255, so every saturated pixel collapses into the last bin |
| `decisionLogOdds` | 0 — the `>=` rather than `>` is load-bearing and makes an **empty model classify everything as corridor** |
| `corridorWidthPx` | 37 — inherited by *both* features; every sampling offset is a fraction of it, so an error here scales all the geometry |
| `compositeResidual.sampleStepPx` | 4 |
| `skipStartSamples` / `skipEndSamples` | 3 / 4 — 12px and 16px of arclength; asymmetric, and 16px is less than the 24px badge half-width |
| `compositeResidual.edgeDeltaPx` | 3 — explicitly labeled "quick-pass"; rail antialiasing is 1–2px, so 3px is barely clear |
| `badgeSkipPadPx` | 2 — **smaller than `edgeDeltaPx`**, so samples land inside the badge even when the rail center is skipped |
| `residualScaleQuantile` / `residualScaleFloor` | 0.75 / 2 — fully implemented, fully tested, and **called by nothing** |

*Not UNKNOWN:* `histogramPseudoCount` 1 (textbook Laplace add-one); the 0.35W–0.65W rail gap, which deliberately excludes antialiased rail pixels from both classes; `EPSILON` 1e-9.

### Evidence renderers and accuracy reporting

| Name | Value / note |
|---|---|
| scalar colour ramp | R = 255t, G = 255(1−abs(2t−1)), B = 255(1−t) — arbitrary diverging ramp, not colour-blind safe, freely replaceable |
| empty-field fallback range | min 0 / max 1 when `finiteCount === 0` — arbitrary divide-by-zero guard |
| point-cross half-length | 2 px — cosmetic |
| overlay colours | componentSet orange (255,165,0), candidateSet cyan (0,220,255), polyline magenta (255,0,255) — arbitrary; confirm none of them matches a legend in another LAB viewer |
| stub detection | `summary.endsWith('stub only')` — **not a number, but the worst landmine here**: render-coverage accounting hangs off an English phrase, so rewording any stub message silently inflates reported coverage. Every historical "N rendered, M stubbed" figure is suspect. |
| `ASSOCIATION_TOLERANCE_PX` | 26 — silently sets **every** reported accuracy number in T2 and T3 |
| `CANDIDATE_LOCALITY_RADIUS_PX` | 42 — deliberately tied to `componentMaxDim`, and so inherits its unknown provenance |
| `tipOffset` fallback | 4 — hardcoded in `familyTuning.test.ts` |

### Architecture ratchet

| Name | Value / note |
|---|---|
| `SIZE_LIMIT` | 600 — apparently chosen so that exactly 27 files land above it |
| `NEW_PRODUCTION_WARNING_LIMIT` | 400 — two-thirds of the fail limit |
| `NEW_WORKSPACE_WARNING_LIMIT` | 300 — the docs say "target 250–300"; the 250 appears nowhere in code |
| `NEW_ROUTE_WARNING_LIMIT` | 100 — the intent is explicit (a route should have nowhere to hide logic), the number is not |
| moved at face value, never re-measured | `DEFAULT_NAIP_RADIUS_METERS` 300, `TILE_RADIUS_METERS` 300, `DEFAULT_BOX_FRACTION` 0.9, `MIN_BOX_SIZE_PX` 128, `CROP_ZOOM_SOURCE_WIDTH_PX` 24, `CROP_ZOOM_ROWS_ABOVE` / `ROWS_BELOW` 8 / 8, `CROP_ZOOM_SCALE` 8 |

*Not UNKNOWN:* Circle 1 = 10 m and Circle 2 = 20 m (PDGA sport rule); the ±90 / ±180 lat-lon guards.

### Review UI and local snap (all uncommitted)

| Name | Value / note |
|---|---|
| marker click-versus-drag | 5 px |
| review camera initial zoom | courseFit × 2, clamped to [`reviewMinScale`, 1] |
| review camera zoom step | 1.1^delta, clamped to [`reviewMinScale`, 4] |
| review camera fit padding | 48 px |
| review viewport safe-width inset | 24 px |
| `reviewMinScale` initial | 0.02 |
| `LOCAL_SNAP_CROP_FEATURE_MULTIPLE` | 4 — the *timings* behind it were really measured; the multiple itself is judgement |
| `LOCAL_SNAP_RADIUS_FEATURE_MULTIPLE` | 0.5 — "half the expected footprint", no measurement cited |
| `LOCAL_SNAP_MAX_ABSOLUTE_RADIUS_PX` | 24 — the *need* for a cap is documented at length; the 24 is not |
| `LOCAL_SNAP_MIN_SCORE` | 0.5 — the linkage to basket template detection is reasoned; the 0.5's own origin is not |
| `TEE_PAD_MAX_FOOTPRINT_UI_SCALE_MULTIPLE` | 26 — a duplicated constant whose link is enforced only by a prose comment |
| `MIN_CROP_SIDE_PX` | 4 |
| `THROWN_ROUND_PURPLE_MASS_MIN` | 0 — **a threshold of 0 is a disabled gate** |
| `STEPS` order | `['tee','basket','bends']` — a product decision with undocumented rationale, but three derived behaviors depend on it |

### Middle-out probe (Python)

| Name | Value / note |
|---|---|
| `badge_gray_threshold` | 50 — mirrors production; the probe sweeps 40/50/60/70 precisely because it was suspect |
| badge width / height / aspect / fill gates | 12–120 px, 9–90 px, 1.12–1.75, ≥0.55 — all mirror production, whose own derivation is unrecorded |
| badge size-cluster tolerance | log(1.2), i.e. ±20% |
| `max_candidates` | 18 — **known-wrong** for Fountain Hills Pro's 20 holes; it manufactures false absences, and a hard assertion turns a recall shortfall into a crash |
| `bandness_scale` | 3 source px per evidence px |
| `bandness_widths_src` | (24,32,40,48,56,64) — named by CHSPT-58 as the primary scale-failure suspect |
| `bandness_orientations` | 12 (15° steps over 180°) |
| `bandness_preblur_sigma` | 0.8 px |
| bank sampling offset | max(1.0, 4.0/scale) = 4 source px |
| normalization percentile | 99.5th of nonzero response |
| response gamma | 0.7 |
| support cost curve | 1.0 + 4.0(1−support)² — both the 4.0 and the exponent unknown |
| route margin fraction / floor | 0.60 of the chord / 30 evidence px |
| endpoint occlusion relief | radius 6 evidence px, cost floor 1.4 |
| badge-to-hole assignment tiebreak | +0.02 × endpoint distance |
| Hough params | dp 1.2, minDist 10, param1 80, param2 20, radius 8–65 at 0.5 downscale — **demonstrably wrong**: 3 of 4 captures were false positives |

*Not UNKNOWN:* the BT.601 luma coefficients with `floor(x+0.5)`, bit-matched to production on purpose; the per-capture crop tops, which are measured screenshot-chrome offsets.

---

## 5. Decisions only the owner can make

Ranked by how much downstream work each one blocks. None of these can be settled by reading more code — every one needs a human ruling.

### Tier 1 — blocks whole families of work

1. **What does a `null` / UNKNOWN score mean to a consumer?** The four-lane sensor is scrupulous: hidden pixels yield `null`, never zero. But no consumer exists yet, so nothing constrains this. If the first one treats `null` as "no corridor" rather than "no information", the trophy-basket catastrophe returns one layer above the sensor. Constrains steps 9–11 of the regeneration order and cannot be deferred past the first consumer.
2. **Does the ST gate get a real pose/tracker seam on the evidence board, and in what shape?** Four specs — the four-lane cluster, badge transit, minimum run, and materialMap/residual — are all explicitly blocked on a slot nobody invented. Until it exists, each of them is registered dead code whose ON config changes exactly zero pixels.
3. **Should a rejected detection be deleted, or demoted to a tier tag?** G2 rejection currently deletes both the sprite and the basket. Downstream reads that as "no basket here"; the two occlusion recovery tiers were never ported; and deleting a sprite punches a 24px hole in G3's tee-exclusion mask, so a phantom tee can spawn on top of a real occluded basket and an inspector blames the wrong stage. This sets the negative-evidence contract for the whole pipeline, not just G2.
4. **Which badge-inset polarity is correct — LAB's −7px shrink or the engine's +3px grow?** Opposite signs, a 10px net swing per side, plus an extra `pointInScreenChrome` filter the LAB never had. The engine therefore feeds G3 a strictly smaller candidate set than the reference implementation ever ran on, and emits a confident numeric rejection for tees the LAB kept. If teeFamily under-produces, this is the first suspect — **not** the seven family knobs.
5. **Re-fit the unexplained thresholds against real rasters, or carry them forward blind?** Section 4 lists roughly ninety numbers with no derivation. Carrying them preserves comparability with historical Dev72 figures; re-fitting makes them defensible. You cannot have both. The `familyTuning` harvest harness is a ready template if the answer is "re-fit".

### Tier 2 — blocks a specific feature or an accuracy claim

6. **Are any of the recorded accuracy numbers reproducible, or should they be struck?** Nearly every figure in these specs is an unreproduced source claim with **zero rendered evidence images**, and several cite producers that were searched for and not found: orient-rails IoU 0.695 / 0.694 / 0.732 / 0.738; course-width Dash 40/40, Heritage 30/30, Lenard 36/37, TowneLake 36/37; the minimum-run AUC tables; compositeResidual AUC ~0.664 and its per-course spread; the DashsTrack 18/18 scoreboard; the 0.778→0.838 and 0.796→0.968 snap rates (backed only by an external repo not on this machine). Under this project's own rule, none of them is currently claimable.
7. **What is materialMap's minimum sample count, and what should an uninformative model return?** With zero training samples both histograms are uniform, logOdds is 0, and `0 >= 0` classifies **every pixel as corridor**. A test pins this, so it is intended — but a course where no frozen half survived would report total corridor coverage instead of "I know nothing".
8. **How much padding keeps badge pixels out of the material models?** materialMap has no notion of a badge at all; its only protection is `segmentEndFraction = 0.80` against a ~48px-wide badge, so on any Tee→Badge half shorter than ~120px the inside taps train badge glyphs as corridor while the outside taps train the badge halo as background — both histograms poisoned in opposite directions, silently. compositeResidual tests the rail center against a padded bbox but samples 3px away with only 2px of pad. Decide the padding, and whether to skip-only (safe polarity) or also refuse to score.
9. **Adopt the localSnap clickfix diff, or discard it?** Its default (`clickFix: false`) reverts commit `4da01fb`, which the rebuild **already has** — applying it naively turns off shipped behavior. Its OFF arm is the named trap in miniature: the crop is 4× the footprint while the accept radius is min(0.5 × footprint, 24px); a neighbouring feature outscores the one under the click, the single winner fails the radius test, and the function returns `null`, which renders to the user as "nothing happened". The deleted comment records that in every such rejection the in-radius runner-up *was* the real feature. **Never treat "local snap returned nothing" as evidence about the image.** Options: port with default true, re-run the A/B on the rebuild's corpus, or keep only this prose.
10. **Is `teeSpriteExclusionDistance = 24` right, and should sprite suppression use mask overlap instead of centroid distance?** This is the live trophy-swallows-tee mechanism, and nobody has ever made it a decision.
11. **Should `minRequiredRunPx` ship non-zero, and should "unknown" samples ever bridge a run?** The shipped 0 is inert; 24 is folklore. The bridging question is exactly where fat-bbox false negatives live, and it has never been measured.
12. **Is the four-lane clamp asymmetry intentional?** The base sensor uses `clamp01`; orientedRails uses `min(1,x)` with a strict `> 0` gate, so a rail rendered darker than its surroundings (dark-mode map) scores nothing rather than low.
13. **Should `orientedRails` accept more than one occluder per cross-section?** It currently cannot represent a badge **and** a basket occluding the same slice; the second one's pixels are read as real evidence. A correctness gap, not a style preference.
14. **Is `sampleFractions`' 0.78 a typo for 0.8?** Flagged, not corrected. Needs a ruling plus an A/B run.
15. **Is `orientationCount = 24` meaningful at all?** It came from a prose study document; no implementation producing it was ever located. Re-derive it empirically, or drop the feature.

### Tier 3 — hygiene, tooling, and archaeology

16. **Re-pin the red test.** The chspt-82 working tree is red: `artifactRenderers.test.ts` still pins the pre-fix mask hash while the uncommitted `renderMask` change produces different bytes. Confirm and re-pin — and fix the fixture, which uses `[0,255,128,64]` rather than real 0/1 mask bytes and so does not reproduce the defect it was re-pinned for.
17. **Wire or delete compositeResidual's recorded scale** (q75 with floor 2). Leaving it in place implies a calibrated threshold exists when none does.
18. **Merge the ST schema node once.** Both material branches independently add an `ST` node and each bumps the resolved-config pin to a different hash; they conflict textually and cannot both be regenerated naively.
19. **Does the rebuild want an architecture ratchet at all, and when?** Its real seam is already `packages/alg` (pure) versus `src` (Svelte), enforced by the package manifest. A five-zone taxonomy may add nothing over that one boundary, and freezing a baseline mid-rebuild locks in today's mess behind a deliberately painful escape hatch.
20. **Should the 18-badge cap become a function of hole count, be dropped, or become a confidence cutoff?** The probe never faced this because its whole corpus was 18-hole courses.
21. **Re-capture Fountain Hills, or drop it from scope?** Every output *and* every input was gitignored and is gone, so the experiment cannot regenerate its own evidence.
22. **Open `hole-11-basket-near-neighbor-tee-leakage-risk-.png`** (under `old-stuff/scripts/cv-probes/corridor-evidence-grid-results-ts/`). It is named after exactly the trophy-basket-bbox-swallows-tee failure and was reported by filename only, never opened. It may be the canonical evidence image for the project's named hazard.
23. **Copy the binary corpus off this machine.** `TheRec-L.PNG`, `TheRec-R.PNG`, and `TheRec-Thrown-full.PNG` (3.8 / 4.0 / 4.7 MB) exist only inside two dirty worktrees, are treated as fair-use-sensitive by the code (pixels are deliberately discarded at `confirmAnnotation`), and cannot be carried by any document here. It is also unverified whether the two copies are byte-identical.
24. **Answer the small orphan questions:** who owns `stepPx` long-term; whether run span is center-to-center or swept; whether `selectHole` wiping a hole's step decisions is intended or a bug; whether T3's measured `componentMinArea = 50` should become a default; whether T5's and T6's `Receipt.work` shapes reconcile; whether `baseRasterPngPath` should be wired so overlay rendering is reachable at all; whether badgeOcclusionPatch's slot republish is genuinely behavior-neutral; and why the demo work sat uncommitted since 2026-08-23.
