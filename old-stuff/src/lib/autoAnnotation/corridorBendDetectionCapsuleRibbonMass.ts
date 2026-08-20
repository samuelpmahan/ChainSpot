/**
 * Arm D: the capsule-scoring engine (`fitCapsuleBends`,
 * `corridorBendDetectionCapsule.ts`) driven by this branch's modern
 * ribbon-mass/occluder-bridge/ring-arc evidence substrate
 * (`buildModernCorridorEvidence`, `corridorEvidenceGridRibbonMass.ts`) instead
 * of arm C's own classic LAB-lightness evidence. The two halves were built as
 * genuinely independent, parallel pieces of work around the shared
 * `CorridorEvidenceGrid` contract (`corridorEvidenceGrid.ts`) specifically so
 * this file could be a thin wire-up rather than a fifth from-scratch
 * detector: it contains no new evidence construction and no new search logic
 * of its own.
 *
 * Cost shape mirrors `corridorBendDetectionRibbonMass.ts`: a whole-course
 * `segmentRibbonMass` pass (amortized across every hole) plus a whole-course
 * `discoverBasketRingRadiiPx` pass (also amortized — it needs every basket
 * position for a stable radial profile, see that function's doc comment),
 * then a cheap per-hole `buildModernCorridorEvidence` + `fitCapsuleBends`
 * call. Both one-time costs are the caller's to compute once and reuse; this
 * module never re-runs them internally, same convention
 * `detectCorridorBendsRibbonMass` documents for its own `segmentation`
 * parameter.
 *
 * Same output contract as the other four detectors: a plain `SourcePoint[]`
 * of bend points, ordered tee-to-basket, no confidence/provenance field ever
 * attached (see `annotatedRound.ts`'s provenance rule). This module is NOT
 * wired into `applyDetectedCorridorBends` or any live editing flow.
 *
 * BENCHMARK RESULT (`scripts/benchmark-corridor-bend-detection.ts`, Dash +
 * AlexClark): contrary to the hypothesis that drove building this arm, it
 * UNDERPERFORMS arm C (the same capsule engine over
 * `buildClassicCorridorEvidence`) on both courses — Dash 83% exact count
 * (15/18) vs. arm C's 94% (17/18), losing holes 4/7/8 to zero-bend
 * COUNT WRONG that arm C got right; AlexClark 33% (1/3) vs. arm C's 100%
 * (3/3), losing holes 1/2 the same way. Root-caused directly (see holes 7/8):
 * the modern evidence substrate is genuinely much SPARSER than classic
 * evidence over the same crop — cells >= 0.5 cover only 6-8% of the window
 * (mean 0.07-0.10) vs. classic evidence's 29-32% (mean 0.30-0.32) — even
 * though real, non-zero signal IS present at the true bend location (e.g.
 * hole 7's tee-basket midpoint reads 0.50 in the modern grid). This is a
 * REGION EVIDENCE mismatch, not a hole-ownership or search-engine bug: the
 * capsule scorer's acceptance margin (`capsuleMarginScore`, 0.03) and the
 * rest of `DEFAULT_CAPSULE_FIT_PARAMS` were implicitly tuned against classic
 * evidence's density (via the Python probe's own historical validation);
 * `ribbonMass.ts`'s pre-threshold `opened` field, this substrate's source,
 * is a morphologically-opened field shaped for BINARY component extraction,
 * not a smoothly graded local-contrast field the way classic evidence's
 * ΔL-vs-box-mean construction is — so a real bend's averaged capsule gain
 * over the modern substrate is too small, relative to the straight-chord
 * baseline, to clear the same margin that works cleanly over classic
 * evidence. Kept in this branch as a documented, honest negative result
 * (per this session's own "diagnose which stage failed, don't invent a
 * fifth detector family" standard) — arm C is the one worth carrying
 * forward, not this hybrid.
 */
import type { SourcePoint } from '../domain/annotatedRound';
import { DEFAULT_CAPSULE_FIT_PARAMS, fitCapsuleBends } from './corridorBendDetectionCapsule';
import type { CapsuleFitParams } from './corridorBendDetectionCapsule';
import { DEFAULT_CORRIDOR_EVIDENCE_GRID_PARAMS, buildModernCorridorEvidence } from './corridorEvidenceGridRibbonMass';
import type { CorridorEvidenceGridParams, RibbonMassSegmentationForEvidence } from './corridorEvidenceGridRibbonMass';

export interface DetectCorridorBendsCapsuleRibbonMassParams {
	readonly evidence: CorridorEvidenceGridParams;
	readonly fit: CapsuleFitParams;
}

export const DEFAULT_DETECT_CORRIDOR_BENDS_CAPSULE_RIBBON_MASS_PARAMS: DetectCorridorBendsCapsuleRibbonMassParams = {
	evidence: DEFAULT_CORRIDOR_EVIDENCE_GRID_PARAMS,
	fit: DEFAULT_CAPSULE_FIT_PARAMS
};

/**
 * Proposes zero or more corridor bend points between `teeSrcPx` and
 * `basketSrcPx`, in SOURCE-image pixels, ordered tee-to-basket — arm D.
 * `badgeSrcPx` omitted falls back to an unanchored fit (see
 * `fitCapsuleBends`'s doc comment); `ringRadiiPx` empty falls back to
 * `buildModernCorridorEvidence`'s no-damping/no-bridging conservative mode
 * (see that function's doc comment) rather than failing.
 *
 * Returns `[]`, not an error, when `buildModernCorridorEvidence` returns
 * `null` (a degenerate tee/basket/badge crop window) — matching every other
 * detector in this family's "nothing usable here" convention rather than a
 * sentinel a caller would need to special-case.
 */
export function detectCorridorBendsCapsuleRibbonMass(
	segmentation: RibbonMassSegmentationForEvidence,
	teeSrcPx: SourcePoint,
	basketSrcPx: SourcePoint,
	badgeSrcPx: SourcePoint | undefined,
	ringRadiiPx: readonly number[] = [],
	params: DetectCorridorBendsCapsuleRibbonMassParams = DEFAULT_DETECT_CORRIDOR_BENDS_CAPSULE_RIBBON_MASS_PARAMS
): SourcePoint[] {
	const grid = buildModernCorridorEvidence(segmentation, teeSrcPx, basketSrcPx, badgeSrcPx, ringRadiiPx, params.evidence);
	if (!grid) return [];
	return fitCapsuleBends(grid, teeSrcPx, basketSrcPx, badgeSrcPx, params.fit);
}
