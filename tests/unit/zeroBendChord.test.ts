import { describe, expect, it } from 'vitest';
import { evaluateZeroBendBadgeOnChord } from '../../src/lib/autoAnnotation/zeroBendChord';
import {
	computeZeroBendLocks,
	deriveP6LowParBasketAssignment,
	scoreLowParBasketCandidate
} from '../../src/lib/autoAnnotation/p6LowParBasketAssignment';
import {
	buildClassicCorridorEvidence,
	DEFAULT_CLASSIC_CORRIDOR_EVIDENCE_PARAMS
} from '../../src/lib/autoAnnotation/corridorBendDetectionCapsule';
import type { CorridorBendRaster } from '../../src/lib/autoAnnotation/corridorBendDetection';
import { segmentRibbonMass, DEFAULT_RIBBON_MASS_PARAMS } from '../../src/lib/autoAnnotation/ribbonMass';
import type { RawMaskBasket, RawMaskTee } from '../../src/lib/autoAnnotation/rawObjectMask';
import type { P2LabeledBadge } from '../../src/lib/autoAnnotation/rawObjectOwnership';
import type { P4RibbonOwnershipResult } from '../../src/lib/autoAnnotation/p4RibbonOwnership';
import type { P5SparseAssignmentResult, P5TeeAssignment } from '../../src/lib/autoAnnotation/p5SparseAssignment';

describe('evaluateZeroBendBadgeOnChord', () => {
	it('accepts a straight-hole badge near the chord midpoint (small offset, t~0.5)', () => {
		const result = evaluateZeroBendBadgeOnChord(
			{ xPx: 0, yPx: 0 },
			{ xPx: 200, yPx: 0 },
			{ xPx: 101, yPx: 1 }
		);
		expect(result.onChord).toBe(true);
		expect(result.distancePx).toBeCloseTo(1, 5);
		expect(result.t).toBeCloseTo(0.505, 3);
	});

	it('accepts at the tolerance boundary: badge exactly 3px off-chord at t=0.5 (<=3px is inclusive)', () => {
		const result = evaluateZeroBendBadgeOnChord(
			{ xPx: 0, yPx: 0 },
			{ xPx: 200, yPx: 0 },
			{ xPx: 100, yPx: 3 }
		);
		expect(result.distancePx).toBeCloseTo(3, 5);
		expect(result.t).toBeCloseTo(0.5, 5);
		expect(result.onChord).toBe(true);

		// One step past the boundary must flip to false -- confirms <= is the
		// actual operator, not a fuzzy/rounded comparison.
		const justOver = evaluateZeroBendBadgeOnChord(
			{ xPx: 0, yPx: 0 },
			{ xPx: 200, yPx: 0 },
			{ xPx: 100, yPx: 3.01 }
		);
		expect(justOver.onChord).toBe(false);
	});

	it('rejects a bent-hole badge 11px off-chord at t~0.5 (low end of the measured 11-35px bent range)', () => {
		const result = evaluateZeroBendBadgeOnChord(
			{ xPx: 0, yPx: 0 },
			{ xPx: 200, yPx: 0 },
			{ xPx: 100, yPx: 11 }
		);
		expect(result.t).toBeCloseTo(0.5, 5);
		expect(result.distancePx).toBeCloseTo(11, 5);
		expect(result.onChord).toBe(false);
	});

	it('rejects a bent-hole badge 35px off-chord at t~0.5 (high end of the measured 11-35px bent range)', () => {
		const result = evaluateZeroBendBadgeOnChord(
			{ xPx: 0, yPx: 0 },
			{ xPx: 200, yPx: 0 },
			{ xPx: 100, yPx: 35 }
		);
		expect(result.t).toBeCloseTo(0.5, 5);
		expect(result.distancePx).toBeCloseTo(35, 5);
		expect(result.onChord).toBe(false);
	});

	it('rejects when t is outside [0.4, 0.6] even though the perpendicular distance alone would pass', () => {
		// t ~ 0.1: close to the tee end of the chord, 1px perpendicular offset.
		const nearTee = evaluateZeroBendBadgeOnChord(
			{ xPx: 0, yPx: 0 },
			{ xPx: 200, yPx: 0 },
			{ xPx: 20, yPx: 1 }
		);
		expect(nearTee.distancePx).toBeCloseTo(1, 5);
		expect(nearTee.t).toBeCloseTo(0.1, 5);
		expect(nearTee.onChord).toBe(false);

		// t ~ 0.9: close to the basket end of the chord, 1px perpendicular offset.
		const nearBasket = evaluateZeroBendBadgeOnChord(
			{ xPx: 0, yPx: 0 },
			{ xPx: 200, yPx: 0 },
			{ xPx: 180, yPx: 1 }
		);
		expect(nearBasket.distancePx).toBeCloseTo(1, 5);
		expect(nearBasket.t).toBeCloseTo(0.9, 5);
		expect(nearBasket.onChord).toBe(false);
	});

	it('rejects a degenerate zero-length tee-to-basket chord without producing NaN', () => {
		const result = evaluateZeroBendBadgeOnChord(
			{ xPx: 10, yPx: 20 },
			{ xPx: 10, yPx: 20 },
			{ xPx: 10, yPx: 20 }
		);
		expect(result).toEqual({ onChord: false, distancePx: 0, t: 0 });
	});
});

// ---------------------------------------------------------------------------
// P6-level lock-selection logic (the exported pure helper P6 actually calls,
// factored out so "exactly one candidate locks, zero or multiple don't" is
// provable without a CorridorBendRaster / real ribbon segmentation).
// ---------------------------------------------------------------------------

const P6_TEES: readonly RawMaskTee[] = [
	{ xPx: 80, yPx: 55, orientationDeg: 0, widthPx: 6, heightPx: 6, areaPx: 36, fill: 1 }
];
const P6_BADGES: readonly P2LabeledBadge[] = [
	{ holeNumber: 1, glyphScore: 0.9, xPx: 100, yPx: 55, widthPx: 20, heightPx: 20 }
];

function p5WithSingleTee(): P5SparseAssignmentResult {
	const assignment: P5TeeAssignment = {
		teeIndex: 0,
		assignedHoleNumber: 1,
		candidateHoleNumbers: [1],
		assignedAxisErrorPx: 0,
		p4Status: 'unresolved',
		p4HoleNumber: null,
		status: 'assigned',
		reason: 'hungarian'
	};
	return {
		assignments: [assignment],
		assignedTees: 1,
		unresolvedTees: 0,
		totalAssignmentCost: 0,
		duplicateBadges: [],
		disallowedAssignmentsRejected: 0,
		perfectMatchingFound: true
	};
}

describe('computeZeroBendLocks (P6 pure helper)', () => {
	it('locks the hole when exactly one basket is on-chord', () => {
		const baskets: readonly RawMaskBasket[] = [
			{ xPx: 120, yPx: 55, centerXPx: 120, centerYPx: 55, widthPx: 8, heightPx: 8, areaPx: 64, fill: 1 }
		];
		const locks = computeZeroBendLocks(P6_TEES, baskets, P6_BADGES, p5WithSingleTee(), new Set(), new Set());
		expect(locks.get(1)).toBe(0);
		expect(locks.size).toBe(1);
	});

	it('does not lock when zero baskets are on-chord (badge off-chord)', () => {
		const baskets: readonly RawMaskBasket[] = [
			{ xPx: 120, yPx: 150, centerXPx: 120, centerYPx: 150, widthPx: 8, heightPx: 8, areaPx: 64, fill: 1 }
		];
		const locks = computeZeroBendLocks(P6_TEES, baskets, P6_BADGES, p5WithSingleTee(), new Set(), new Set());
		expect(locks.size).toBe(0);
	});

	it('does not lock when more than one basket is on-chord (ambiguous)', () => {
		const baskets: readonly RawMaskBasket[] = [
			{ xPx: 119, yPx: 55, centerXPx: 119, centerYPx: 55, widthPx: 8, heightPx: 8, areaPx: 64, fill: 1 },
			{ xPx: 121, yPx: 55, centerXPx: 121, centerYPx: 55, widthPx: 8, heightPx: 8, areaPx: 64, fill: 1 }
		];
		const locks = computeZeroBendLocks(P6_TEES, baskets, P6_BADGES, p5WithSingleTee(), new Set(), new Set());
		expect(locks.size).toBe(0);
	});

	it('never locks a hole already claimed by a P4 lock, even if it would otherwise qualify', () => {
		const baskets: readonly RawMaskBasket[] = [
			{ xPx: 120, yPx: 55, centerXPx: 120, centerYPx: 55, widthPx: 8, heightPx: 8, areaPx: 64, fill: 1 }
		];
		const locks = computeZeroBendLocks(
			P6_TEES,
			baskets,
			P6_BADGES,
			p5WithSingleTee(),
			new Set([1]), // hole 1 already p4-locked
			new Set()
		);
		expect(locks.size).toBe(0);
	});

	it('excludes an already-locked basket from consideration, which can turn a would-be lock into no lock', () => {
		const baskets: readonly RawMaskBasket[] = [
			{ xPx: 120, yPx: 55, centerXPx: 120, centerYPx: 55, widthPx: 8, heightPx: 8, areaPx: 64, fill: 1 }
		];
		// The one on-chord basket (index 0) is already claimed elsewhere (e.g. by
		// a P4 lock on a different hole) -- zero remaining candidates, no lock.
		const locks = computeZeroBendLocks(P6_TEES, baskets, P6_BADGES, p5WithSingleTee(), new Set(), new Set([0]));
		expect(locks.size).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Full P6 integration: proves the shortcut actually BYPASSES ribbon evidence
// (not merely agreeing with it) by constructing a tee/badge/basket triple
// whose entire polyline falls inside scoreLowParBasketCandidate's own
// badge-exclusion mask -- ribbon scoring returns null for it regardless of
// raster content -- and confirming P6 still resolves the hole correctly via
// the zero-bend shortcut.
// ---------------------------------------------------------------------------

function flatRaster(widthPx: number, heightPx: number): { data: Uint8Array; widthPx: number; heightPx: number; channels: 4 } {
	const data = new Uint8Array(widthPx * heightPx * 4);
	for (let i = 0; i < widthPx * heightPx; i += 1) {
		data[i * 4] = 120;
		data[i * 4 + 1] = 120;
		data[i * 4 + 2] = 120;
		data[i * 4 + 3] = 255;
	}
	return { data, widthPx, heightPx, channels: 4 };
}

const EMPTY_P4: P4RibbonOwnershipResult = {
	teeResolutions: [],
	basketEvidence: [],
	holes: [],
	sharedComponentLabels: [],
	endpointContactRadiusPx: 0
};

describe('deriveP6LowParBasketAssignment: zero-bend shortcut bypasses ribbon evidence', () => {
	it('resolves a hole via zeroBendLocked whose own ribbon-evidence score is null (no ribbon evidence available)', () => {
		const tees: readonly RawMaskTee[] = [
			{ xPx: 80, yPx: 55, orientationDeg: 0, widthPx: 6, heightPx: 6, areaPx: 36, fill: 1 }
		];
		const badges: readonly P2LabeledBadge[] = [
			{ holeNumber: 1, glyphScore: 0.9, xPx: 100, yPx: 55, widthPx: 20, heightPx: 20 }
		];
		// tee->badge->basket all sit within +-20px of the badge, well inside
		// scoreLowParBasketCandidate's +-34px/+-24px badge-exclusion mask: every
		// sample point along the polyline gets excluded, so the ribbon line
		// score has zero usable samples (< LOW_PAR_MIN_SAMPLE_COUNT) and
		// returns null for this exact triple no matter what the raster shows.
		const baskets: readonly RawMaskBasket[] = [
			{ xPx: 120, yPx: 55, centerXPx: 120, centerYPx: 55, widthPx: 8, heightPx: 8, areaPx: 64, fill: 1 }
		];

		const rawRaster = flatRaster(240, 110);
		const raster: CorridorBendRaster = { ...rawRaster, originXPx: 0, originYPx: 0, scale: 1 };

		// Directly confirm ribbon evidence really would fail for this triple --
		// the same evidence grid P6 builds internally, scored the same way.
		const evidenceGrid = buildClassicCorridorEvidence(
			raster,
			{ xPx: tees[0].xPx, yPx: tees[0].yPx },
			{ xPx: baskets[0].centerXPx, yPx: baskets[0].centerYPx },
			DEFAULT_CLASSIC_CORRIDOR_EVIDENCE_PARAMS
		);
		const wouldBeRibbonScore = scoreLowParBasketCandidate(
			evidenceGrid,
			{ xPx: tees[0].xPx, yPx: tees[0].yPx },
			{ xPx: badges[0].xPx, yPx: badges[0].yPx },
			{ xPx: baskets[0].centerXPx, yPx: baskets[0].centerYPx }
		);
		expect(wouldBeRibbonScore).toBeNull();

		const ribbonSegmentation = segmentRibbonMass(
			rawRaster,
			badges.map((badge) => ({ xPx: badge.xPx, yPx: badge.yPx })),
			DEFAULT_RIBBON_MASS_PARAMS
		);

		const p6Result = deriveP6LowParBasketAssignment(
			raster,
			tees,
			baskets,
			badges,
			p5WithSingleTee(),
			EMPTY_P4,
			ribbonSegmentation
		);

		const holeAssignment = p6Result.assignments.find((assignment) => assignment.holeNumber === 1);
		expect(holeAssignment?.status).toBe('zeroBendLocked');
		expect(holeAssignment?.assignmentReason).toBe('zeroBendLocked');
		expect(holeAssignment?.assignedBasketIndex).toBe(0);
		expect(holeAssignment?.lowParScore).toBeNull();
		expect(p6Result.lockedByZeroBend).toBe(1);
	});

	it('control: the same triple does NOT lock when the badge is off-chord (falls through unchanged)', () => {
		const tees: readonly RawMaskTee[] = [
			{ xPx: 80, yPx: 55, orientationDeg: 0, widthPx: 6, heightPx: 6, areaPx: 36, fill: 1 }
		];
		const badges: readonly P2LabeledBadge[] = [
			{ holeNumber: 1, glyphScore: 0.9, xPx: 100, yPx: 55, widthPx: 20, heightPx: 20 }
		];
		// Basket moved so the badge is nowhere near the tee->basket chord
		// (t << 0.4): the zero-bend shortcut must not fire here.
		const baskets: readonly RawMaskBasket[] = [
			{ xPx: 120, yPx: 150, centerXPx: 120, centerYPx: 150, widthPx: 8, heightPx: 8, areaPx: 64, fill: 1 }
		];

		const rawRaster = flatRaster(240, 200);
		const raster: CorridorBendRaster = { ...rawRaster, originXPx: 0, originYPx: 0, scale: 1 };
		const ribbonSegmentation = segmentRibbonMass(
			rawRaster,
			badges.map((badge) => ({ xPx: badge.xPx, yPx: badge.yPx })),
			DEFAULT_RIBBON_MASS_PARAMS
		);

		const p6Result = deriveP6LowParBasketAssignment(
			raster,
			tees,
			baskets,
			badges,
			p5WithSingleTee(),
			EMPTY_P4,
			ribbonSegmentation
		);

		const holeAssignment = p6Result.assignments.find((assignment) => assignment.holeNumber === 1);
		expect(holeAssignment?.status).not.toBe('zeroBendLocked');
		expect(p6Result.lockedByZeroBend).toBe(0);
	});
});
