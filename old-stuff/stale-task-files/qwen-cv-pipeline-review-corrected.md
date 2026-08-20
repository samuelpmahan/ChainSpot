# Qwen 3.8 Max — corrected ChainSpot CV pipeline review

- Session: `ses_fefe8f319ffeXoguaMiRUNL7Ed`
- Model: `opencode-go/qwen3.8-max`
- Review status: accepted after one correction round
- Lead correction: renderer C1/C2 are putting circles, not landing-droplet classes; no synthetic fixture generator was established.
- Cumulative session cost: `$0.125206`

The following is Qwen's revised response, preserved verbatim.

---

# ChainSpot CV Pipeline — Architecture Review (Revised)

Revised per lead-reviewer corrections: (1) renderer C1/C2 are the 10 m/20 m putting circles, not landing-droplet glyph classes — no 2:1 scale prior transfers to droplet detection/classification; (2) no synthetic fixture generator is established by the brief — the played-round evidence is one real fixture plus corpus rules, and I mark missing evidence plainly. Facts/inferences/proposals are labeled.

## 1. Is the separation sound?

**Yes — the separation is sound, but the seams are currently unenforced.** (Unaffected by the corrections; retained.)

The chain provenance/registration → pixel observations → semantic proposals → editable authoritative state matches the observed failure modes:

- The 0/18 tees and 0/18 baskets cautionary result (**fact**) is what happens when stages collapse — course recognition re-run in played-round pixel space. "Known course geometry plus explicit registration" is the correct replacement dependency.
- Keeping detector evidence in proposal state and excluding `source=cv`/confidence from the production artifact (**fact**) makes accepted geometry authoritative and manual edits final — what makes "correctable without restarting" achievable.
- SHA-verifiable provenance (**fact**) makes every scored raster auditable, as the evaluation contract requires.

Caveats (**inference**):

1. Defect 1 (stale `cleanImageId` unenforced) and Defect 5 (stale hole id → silent `addShot` no-op) show both seams can silently pass or drop evidence. The architecture is right; the seams lack integrity checks.
2. Composing played→clean with clean→target (**fact**, item 7) propagates registration error; budgets must cover the composed path.

## 2. Five most important hidden assumptions / coupling risks, ranked by expected MVP impact

**Workflow/state risks**

1. **Unenforced identity at the seams (Defects 1, 5).** References by id without verification at mount/acceptance. Impact: evidence mapped into the wrong project or silently lost while the UI reports success. Ranked first because it silently violates the MVP's core guarantee — a *correct* editable route — even when the detector works. Invisible failure beats loud failure.
2. **Acceptance order coupled to chronology (Defect 2).** Proposals snapshot the same default order; sequential acceptance can reverse chronology (**fact**), while the detector asserts none (**fact**). The acceptance path manufactures order from UI click sequence, directly corrupting "ordered throws."
3. **Manual-recovery and input robustness gaps (Defects 3, 4).** Deferred overlaps surface only as a count; coordinate entry lacks bounds validation, `setHoles` errors are uncaught, clearing a numeric field becomes zero (**facts**). Both violate the non-negotiables: zero-detection/overlap cases must be recoverable; editable state must not silently corrupt (0 is a valid-looking coordinate).

**Detector risks**

4. **Single-fixture calibration assumption.** Fixed HSV thresholds, one canonical glyph mask per class, and coarse pin-shape bounds are demonstrated on exactly one real round (**fact**). Hidden assumptions: UDisc marker blue is stable across devices/captures, and droplet pixel size is predictable. Map geometry scales continuously with zoom (**fact** from renderer research); droplets are map-anchored, so droplet pixel size likely varies with zoom (**inference** — the brief does not directly establish droplet zoom behavior). The detector's resolution-relative bounds (**fact**) partially address this, but across-zoom behavior is unmeasured. This is the largest *empirical* unknown.
5. **Registration acceptance is qualitative.** Residuals and a live preview exist (**fact**), but no quantitative "usable" criterion. Hole assignment inherits 100% of registration error, and low landmark residuals don't bound error far from landmarks. Detector accuracy numbers are meaningless until registration has a number attached.

**Terminology hazard (inference):** "C1/C2" names both the putting circles (renderer research) and the droplet shot-result classes. This collision invites cross-stage conflation — e.g., treating the circles' 2:1 radius prior as a droplet prior, which yields no valid ground truth for droplet detection or classification. Rename or namespace at the boundary.

**Insufficient evidence flag:** the corpus holds one real played-round fixture. No generalization claim beyond it is supported; additional played-round captures require acquisition and labeling, which has not happened.

## 3. Smallest useful error budget and metrics

No stage is measured on a corpus (**fact** — one fixture only), so values are **proposals** to be calibrated by §4. Labeled played-round ground truth beyond the single fixture is **missing**; acquisition and labeling are required before corpus-level budgets can be measured. Protocol: measure each stage with downstream stages replaced by ground truth; normalize pixel errors to clean-source resolution; record with provenance.

| Stage | Metric | Proposed budget |
|---|---|---|
| Registration | Leave-one-out landmark reprojection error in clean px; report median/max; record landmark geometry and model | Median ≤ 3 clean px; no pair > 2× median; else require more/affine pairs before proposals |
| Localization | Detected tip vs. human-marked landing in played space under a reference registration; normalize by droplet height | Median ≤ 0.15 droplet height; 95th pct ≤ 0.3 |
| Classification | Per-class precision/recall + confusion matrix; Dice score distributions to set abstain threshold | Wrong-assertion ≤ 5%; abstentions unlimited but reported — a wrong C1/C2 claim is worse than "review this" |
| Hole assignment | Top-1 accuracy of suggested hole; no-suggestion rate | Top-1 ≥ 90% on dev set; missed suggestion acceptable, wrong suggestion inside the corridor bound not |
| Ordering | Pairwise inversion rate vs. operator-accepted order (Kendall's τ) | Report-only for MVP — detector asserts no chronology; correct default is "unordered," not a score |
| Final semantic correctness | Per-hole route: hole id ∧ all landings ∧ order ∧ each landing ≤ 0.25 corridor width | Headline product metric: **operator edits per accepted route** — CV exists to accelerate annotation |

## 4. Three falsifying experiments

**E1 — Registration error budget on the real pair.** (Retained; uses the existing fixture.)
- Hypothesis: landmark registration on the one real played-round fixture achieves LOO reprojection ≤ 3 clean px, and refits on landmark subsets move transformed tips less than the localization budget.
- Fixture/split: the existing real-round fixture; landmark subsets varied within it.
- Metric: LOO residual; tip displacement across refits.
- Pass/fail: median LOO ≤ 3 px and max tip displacement ≤ 0.15 droplet height.
- Decision change: pass → budget fixed as enforced config; fail → proposals blocked until residual passes, affine/more pairs required, and registration UX work moves ahead of all detector work.

**E2 — Generalization on newly acquired, labeled played-round captures.** (Replaces the prior synthetic-compositing design, which assumed a fixture generator the brief does not establish.)
- Hypothesis: the current detector configuration, unmodified, detects ≥ 90% of droplets at ≥ 95% precision with tip error ≤ 0.15 droplet height and glyph wrong-assertion ≤ 5% on at least two additional real played-round screenshots spanning at least two zoom levels.
- Fixture/split: **missing evidence — acquisition and labeling are required.** New captures must follow corpus rules: dev-set courses, split unit = course + layout + capture artifact, varied capture conditions, reproducible from original captures plus provenance. Until labeled captures exist, this hypothesis is untestable and generalization must be assumed unproven.
- Metric: detection recall/precision, tip error, glyph classification accuracy vs. human labels.
- Pass/fail: all thresholds on both captures; any miss fails.
- Decision change: fail → thresholds/shape bounds become explicit config requiring calibration, an abstain path is added, and MVP scope is re-scoped to conditions where the detector is measured; pass → proceed toward sealed-set planning.

**E3 — Acceptance-path integrity after Defect 2/5 fixes.** (Retained; uses the existing fixture.)
- Hypothesis: with explicit unordered default and stale-id guards, scripted acceptance sequences (accept-all, accept-subset, reorder, injected stale hole id, injected out-of-bounds point) yield zero silently lost proposals and zero unsurfaced errors.
- Fixture/split: the real-round fixture's four proposals replayed through the browser proof path plus fault injection.
- Metric: routes matching scripted intent; silent drops (must be 0); every injected fault surfaces a UI error.
- Pass/fail: 100% order match, 0 silent drops.
- Decision change: fail → all new CV stops until the state layer is fixed; pass → acceptance UX unfrozen for corpus expansion.

## 5. Heuristics/config now vs. learned models later

**Remain explicit heuristics/config for MVP:** HSV threshold and component shape filter (deterministic UI rendering); manual landmarks with similarity/affine and residual display; hole suggestion by centerline distance with corridor-width bound; glyph Dice against canonical masks with explicit abstain threshold; the renderer research's own parameters (putting-circle radii, sprite sizes, colors, tolerances) in config with provenance as its ticket requires — noting those priors belong to course rendering, not droplet extraction. Rationale: tiny corpus, deterministic sprites, operator always in the loop, and diagnostics must preserve exact accept/reject evidence — heuristics are debuggable; at this data scale, learned models are not.

**Could justify learned models later, only with measured evidence:** (a) glyph abstention exceeds ~20% on the representative corpus while humans still classify correctly → a small shape classifier; (b) detection precision collapses across capture conditions due to interference rules can't enumerate. The sealed release sets exist to measure this honestly. The 0/18 course-detection case hints course tee/basket detection may eventually need learning, but that is out of MVP scope and must not leak into the played-round path.

## 6. Renderer forensics: now, later, or not at all?

**Not now for the played-round extractor; later at best — and its natural home is course-side CV, not droplet extraction.** Corrected from my prior version: the renderer research models the *course* renderer (putting circles, corridors, badges, sprites). Its C1/C2 2:1 radius prior describes putting circles and provides **no** ground-truth scale, label, or prior for landing droplets or their glyph classes; the shared names are coincidence. The research's droplet-relevant yield today is procedural only: config-with-provenance and the falsifiable hypothesis loop, both cheap to adopt.

**Evidence that would change this answer:** (1) droplet detection/classification failures on labeled captures are attributed by residual/overlap analysis to compositing interaction with course layers (droplets over circle fills or corridor strokes) rather than template inadequacy → renderer-informed masks become justified; (2) blue-channel UI fragments defeat the color threshold and layer-order modeling demonstrably separates them; (3) direct evidence that droplet sprites render with zoom-bucket-dependent size (not currently established) → zoom-conditioned bounds. Absent that evidence, forensics stays a course-annotation asset and must not become an extractor prerequisite.

## 7. Productionization order (next 4 steps)

State integrity before new CV — every later measurement depends on trustworthy acceptance.

1. **Enforce identity at seams.** Verify `cleanImageId` against provenance SHA at review mount; invalidate/re-confirm registration on clean-source replacement; stale-hole-id `addShot` becomes a surfaced error, never a silent no-op with proposal removal. (Defects 1, 5.)
2. **Fix acceptance semantics.** Proposals default to explicitly unordered; operator sets order; bounds validation on transformed and manual coordinates; catch `setHoles` failures with UI feedback; empty numeric input must not become zero. (Defects 2, 3.)
3. **Deferred-overlap recovery.** Per-region review with split / keep-as-single / discard actions, preserving exact evidence per decision. (Defect 4.)
4. **Instrument the budget and acquire evidence.** Run E1; start E2's capture acquisition and labeling (evidence currently missing) under corpus rules; record per-stage metrics with provenance on every scored run.

Only after these: expand beyond the single fixture. Also rename the C1/C2 collision at the renderer/detector boundary to prevent recurrence of the conflation this revision corrects.
