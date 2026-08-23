// g4.scoring — tee/badge pair-scoring geometry (sigmas, fractions,
// collinearity, ring/zone distances) extracted from scoring.ts, plus the
// fallback-tee bbox and ring-membership constants that are SHARED with
// assignment.ts (recoveredTee) and measure.ts (makeTees) per knob-inventory
// merge note 2 — one knob each, three use sites. Baseline: default ON,
// knobs always apply, defaults byte-equal to the pre-extraction literals.
//
// endpointSupportSampleCount, badgeOverlapWaiverRadius, recoveredTeePrior,
// and minWindowCells were all added post-hoc during the phase-3 sign-off
// sweep (docs/knob-extraction-checklist.md's final grep-every-touched-file
// pass) — every one of the four was missed by every cluster's per-file
// over-report re-scan AND by the original inventory:
//   - endpointSupportSampleCount: scoring.ts's endpointSupport
//     (leg.path.slice(-N)), feeding RawPairEvidence.endpointSupportTee/
//     Basket. Threads through makeRawPairEvidence, which now takes a
//     ScoringKnobs parameter for the first time (previously had no
//     g4.scoring literals of its own).
//   - badgeOverlapWaiverRadius: overlapFactor's badge-exclusion radius
//     (field cells) for the tee/basket-leg path-overlap penalty.
//   - recoveredTeePrior: scorePair's confidence discount applied when
//     tee.tier === 'recovered' (the "1" for non-recovered tees is an
//     identity, not extracted).
//   - minWindowCells: the `Math.max(N, Math.round(worstWindowSrcPx /
//     field.scale))` window-size floor shared by all three weakWindow()
//     call sites (zfitFactor, makeRawPairEvidence, scorePair) — previously
//     assumed to be g5.routing-adjacent "shared infra" and left alone
//     during the g5.zfit fixup (cluster 3), but it was never actually
//     claimed by any cluster's row list.

import type { ABFeature } from './types';

export const g4ScoringFeature = {
	id: 'scoring',
	gate: 'G4',
	kind: 'baseline',
	defaultEnabled: true,
	note: 'Tee-badge-basket pair scoring geometry: zone/ring proximity, orientation, collinearity, basket identity.',
	knobs: {
		fallbackTeeBboxOffset: {
			default: 6,
			note: 'fallback tee bbox half-size when no ring/component geometry exists (shared: assignment.ts recoveredTee, measure.ts makeTees)'
		},
		fallbackTeeBboxSize: {
			default: 12,
			note: 'fallback tee bbox dimension (size x size) when no ring/component geometry exists (shared: assignment.ts recoveredTee, measure.ts makeTees)'
		},
		ringDistance: {
			default: 84,
			note: 'basket-to-tee ring membership distance (shared: assignment.ts recoveredTee onRing, measure.ts makeTees onRing, scoring.ts zoneFactor primary ring)'
		},
		ringTolerance: {
			default: 12,
			note: 'tolerance band around ringDistance for the basket-to-tee ring check (shared: assignment.ts, measure.ts, scoring.ts)'
		},
		zoneFactorDistance: {
			default: 35,
			note: 'close-proximity threshold for the zone factor penalty around a non-owning basket'
		},
		secondaryRingDistance: {
			default: 44,
			note: 'secondary ring distance for the zone factor radial check'
		},
		secondaryRingTolerance: {
			default: 8,
			note: 'tolerance band around secondaryRingDistance for the zone factor radial check'
		},
		radialTolerance: {
			default: 0.5,
			note: 'radial alignment fraction threshold for the zone factor penalty'
		},
		teeOrientationSigma: {
			default: 12,
			note: 'gaussian sigma (degrees) for the tee-to-badge angle penalty'
		},
		badgeFractionTarget: {
			default: 0.36,
			note: 'optimal fractional position of the badge along the tee-basket chord'
		},
		badgeFractionTolerance: {
			default: 0.19,
			note: 'acceptable deviation from badgeFractionTarget before the fraction penalty kicks in'
		},
		badgeFractionSigma: {
			default: 0.15,
			note: 'gaussian sigma for the badge-fraction penalty'
		},
		collinearityWeight: {
			default: 0.6,
			note: 'upward factor for the collinearity bonus'
		},
		collinearitySigma: {
			default: 2,
			note: 'gaussian sigma (degrees) for the collinearity angle penalty'
		},
		basketIdentityFloor: {
			default: 0.4,
			note: 'minimum score factor for the basket identity prior'
		},
		basketScoreOffset: {
			default: 0.2,
			note: 'offset subtracted from basket.score in the basket identity calculation'
		},
		basketScoreScale: {
			default: 0.5,
			note: 'divisor for basket.score normalization in the basket identity calculation'
		},
		endpointSupportSampleCount: {
			default: 3,
			note: 'number of trailing leg-path points averaged for RawPairEvidence.endpointSupportTee/endpointSupportBasket (missed by the per-cluster over-report re-scans; caught in the phase-3 sign-off sweep)'
		},
		badgeOverlapWaiverRadius: {
			default: 8,
			note: 'distance (field cells) from the badge center within which a leg point is exempt from the tee/basket path-overlap penalty (missed by the per-cluster over-report re-scans; caught in the phase-3 sign-off sweep)'
		},
		recoveredTeePrior: {
			default: 0.7,
			note: 'confidence discount applied to a pair score when the tee is a recovered (synthesized) tee rather than a directly-detected one (missed by the per-cluster over-report re-scans; caught in the phase-3 sign-off sweep)'
		},
		minWindowCells: {
			default: 3,
			note: 'minimum window size (field cells) for the weakWindow sliding-window worst-case score, shared by zfitFactor/makeRawPairEvidence/scorePair (missed by the per-cluster over-report re-scans; caught in the phase-3 sign-off sweep)'
		}
	}
} satisfies ABFeature;
