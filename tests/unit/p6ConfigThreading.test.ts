import { describe, expect, it } from 'vitest';
import {
	deriveP6GatedSnapshotPhase,
	deriveP6SwapPhase,
	deriveP6LowParBasketAssignmentSnapshot
} from '../../src/lib/autoAnnotation/p6LowParBasketAssignment';
import type {
	P6BasketAssignment,
	P6BasketCandidate,
	P6LowParBasketAssignmentSnapshot
} from '../../src/lib/autoAnnotation/p6LowParBasketAssignment';
import type { P6Config } from '../../src/lib/autoAnnotation/cvConfig';
import type { RawMaskBasket, RawMaskTee } from '../../src/lib/autoAnnotation/rawObjectMask';
import type { P2LabeledBadge } from '../../src/lib/autoAnnotation/rawObjectOwnership';
import type { P4RibbonOwnershipResult } from '../../src/lib/autoAnnotation/p4RibbonOwnership';
import type { P5SparseAssignmentResult } from '../../src/lib/autoAnnotation/p5SparseAssignment';
import type { RibbonMassSegmentation } from '../../src/lib/autoAnnotation/ribbonMass';
import type { CorridorBendRaster } from '../../src/lib/autoAnnotation/corridorBendDetection';

// --- Synthetic minimal Pancake inputs -------------------------------------
//
// These fixtures are hand-built (not derived from any real image) purely to
// exercise the two P6 config levers in isolation: the forward gate angle
// (geometric, no raster evidence needed to change gate PASS/FAIL) and the
// swap-eligibility threshold (a pure distance comparison over a fabricated
// ribbon-component segmentation we fully control).

function basket(index: number, xPx: number, yPx: number): RawMaskBasket {
	return { xPx, yPx, centerXPx: xPx, centerYPx: yPx, widthPx: 10, heightPx: 10, areaPx: 100, fill: 1 };
}

function tee(xPx: number, yPx: number): RawMaskTee {
	return { xPx, yPx, orientationDeg: 0, widthPx: 10, heightPx: 10, areaPx: 100, fill: 1 };
}

function badge(holeNumber: number, xPx: number, yPx: number): P2LabeledBadge {
	return { holeNumber, glyphScore: 1, xPx, yPx, widthPx: 10, heightPx: 10 };
}

const EMPTY_P4: P4RibbonOwnershipResult = {
	teeResolutions: [],
	basketEvidence: [],
	holes: [],
	sharedComponentLabels: [],
	endpointContactRadiusPx: 0
};

function p5For(teeIndexes: readonly number[]): P5SparseAssignmentResult {
	return {
		assignments: teeIndexes.map((teeIndex, index) => ({
			teeIndex,
			assignedHoleNumber: index + 1,
			candidateHoleNumbers: [index + 1],
			assignedAxisErrorPx: 0,
			p4Status: 'unresolved',
			p4HoleNumber: null,
			status: 'assigned' as const,
			reason: 'hungarian' as const
		})),
		assignedTees: teeIndexes.length,
		unresolvedTees: 0,
		totalAssignmentCost: 0,
		duplicateBadges: [],
		disallowedAssignmentsRejected: 0,
		perfectMatchingFound: true
	};
}

/** A uniform gray raster large enough for `buildClassicCorridorEvidence` to run without crashing. Its evidence values are irrelevant to the forward gate (a pure geometry check); they only need to be non-null/finite so candidates are `valid`. */
function uniformRaster(widthPx: number, heightPx: number): CorridorBendRaster {
	const data = new Uint8Array(widthPx * heightPx * 4);
	for (let i = 0; i < data.length; i += 4) {
		data[i] = 128;
		data[i + 1] = 128;
		data[i + 2] = 128;
		data[i + 3] = 255;
	}
	return { data, widthPx, heightPx, originXPx: 0, originYPx: 0, scale: 1, channels: 4 };
}

describe('P6.1 forward gate: forwardGateAngleDeg threading', () => {
	// Tee at (0,0), badge at (0,100): forward direction is straight "down" (+y).
	// Basket B is offset far enough sideways that badge->basket makes roughly a
	// 70-degree angle with the forward direction -- passes an 80-degree gate,
	// fails a 60-degree gate.
	const raster = uniformRaster(400, 400);
	const trustedTee = tee(0, 0);
	const trustedBadge = badge(1, 0, 100);
	const wideAngleBasket = basket(0, 100 * Math.tan((70 * Math.PI) / 180), 100 + 100); // ~70deg off forward

	function snapshotWithAngle(forwardGateAngleDeg: number): P6LowParBasketAssignmentSnapshot {
		return deriveP6LowParBasketAssignmentSnapshot(
			raster,
			[trustedTee],
			[wideAngleBasket],
			[trustedBadge],
			p5For([0]),
			EMPTY_P4,
			true,
			forwardGateAngleDeg
		);
	}

	it('a ~70deg candidate passes an 80deg gate', () => {
		const snapshot = snapshotWithAngle(80);
		const candidate = snapshot.candidates.find((c) => c.holeNumber === 1 && c.basketIndex === 0);
		expect(candidate?.passedForwardGate).toBe(true);
		expect(snapshot.candidatesAfterGate).toBe(1);
	});

	it('the same ~70deg candidate fails a 60deg gate (and the solver falls back rather than silently keeping it)', () => {
		const snapshot = snapshotWithAngle(60);
		const candidate = snapshot.candidates.find((c) => c.holeNumber === 1 && c.basketIndex === 0);
		expect(candidate?.passedForwardGate).toBe(false);
		expect(snapshot.candidatesAfterGate).toBe(0);
		expect(snapshot.gateFallbackHoles).toBe(1);
	});

	it('deriveP6GatedSnapshotPhase threads p6Config.forwardGateAngleDeg the same way', () => {
		const config: P6Config = { forwardGateAngleDeg: 60, swap: { enabled: true, minRibbonImprovementPx: 20 } };
		const { gatedP6 } = deriveP6GatedSnapshotPhase(raster, [trustedTee], [wideAngleBasket], [trustedBadge], p5For([0]), EMPTY_P4, config);
		expect(gatedP6.forwardGateAngleDeg).toBe(60);
		expect(gatedP6.gateFallbackHoles).toBe(1);
	});
});

describe('P6.2 swap adjudication: minRibbonImprovementPx threading and swap.enabled', () => {
	// Two lowParAssigned holes (1 -> basket 0, 2 -> basket 1) whose ribbon
	// components are, by construction, each closer to the OTHER hole's
	// basket -- i.e. today's assignment is the ribbon-evidence-wrong one and
	// swapping is the ribbon-evidence-correct one. Component 1 (hole 1's
	// ribbon) sits exactly at basket 1's position; component 2 (hole 2's
	// ribbon) sits exactly at basket 0's position. Grid is 20x20, scale 1.
	const widthEv = 20;
	const heightEv = 20;
	const labels = new Int32Array(widthEv * heightEv);
	labels[10 * widthEv + 10] = 1; // component 1 pixel, coincides with basket 1 below
	labels[2 * widthEv + 2] = 2; // component 2 pixel, coincides with basket 0 below

	const segmentation: RibbonMassSegmentation = {
		widthEv,
		heightEv,
		scale: 1,
		labels,
		components: [],
		textureKeptLabels: new Set()
	};

	// Baskets X (currently hole 1's) and Y (currently hole 2's) sit at the
	// OTHER hole's ribbon-component location -- today's assignment is the
	// ribbon-evidence-wrong one. Badges sit at their OWN hole's ribbon
	// component so `ribbonComponentForHole` resolves each hole to the
	// component that is actually near it.
	const baskets: readonly RawMaskBasket[] = [basket(0, 2, 2), basket(1, 10, 10)];
	const badges: readonly P2LabeledBadge[] = [badge(1, 10, 10), badge(2, 2, 2)];

	function candidate(holeNumber: number, basketIndex: number, lowParScore: number): P6BasketCandidate {
		return {
			holeNumber,
			basketIndex,
			forwardProjectionPx: 1,
			forwardAngleDeg: 0,
			passedForwardGate: true,
			lowParScore,
			valid: true,
			rankWithinHole: 1
		};
	}

	function assignment(holeNumber: number, assignedBasketIndex: number, lowParScore: number): P6BasketAssignment {
		return {
			holeNumber,
			teeIndex: holeNumber - 1,
			p4BasketStatus: 'unresolved',
			p4BasketIndex: null,
			candidateBasketCount: 2,
			candidatesBeforeGate: 2,
			candidatesAfterGate: 2,
			gateFallbackUsed: false,
			assignedBasketIndex,
			assignedForwardAngleDeg: 0,
			assignmentReason: 'lowPar',
			lowParScore,
			status: 'lowParAssigned'
		};
	}

	const gatedP6: P6LowParBasketAssignmentSnapshot = {
		assignments: [assignment(1, 0, 0.5), assignment(2, 1, 0.5)],
		candidates: [candidate(1, 0, 0.5), candidate(1, 1, 0.4), candidate(2, 0, 0.4), candidate(2, 1, 0.5)],
		lockedByP4: 0,
		assignedByLowPar: 2,
		unresolved: 0,
		duplicateBaskets: [],
		disallowedAssignmentsRejected: 0,
		totalAssignmentCost: -1,
		lowParHigherIsBetter: true,
		forwardGateAngleDeg: 80,
		candidatesBeforeGate: 4,
		candidatesAfterGate: 4,
		gateFallbackHoles: 0
	};

	// Expected: ribbonAX (component1 -> basket0) = dist((10,10),(2,2)) = sqrt(128) ≈ 11.3137
	//           ribbonBY (component2 -> basket1) = dist((2,2),(10,10)) ≈ 11.3137
	//           currentRibbonCost = ribbonAX + ribbonBY ≈ 22.627
	//           swappedRibbonCost = ribbonAY (component1->basket1=0) + ribbonBX (component2->basket0=0) = 0
	//           ribbonImprovementPx ≈ 22.627
	const EXPECTED_IMPROVEMENT_PX = Math.hypot(8, 8) * 2;

	it('a ribbon improvement at/above the threshold is eligible and applies the swap', () => {
		const config: P6Config = { forwardGateAngleDeg: 80, swap: { enabled: true, minRibbonImprovementPx: 20 } };
		const { adjudicatedP6, swapAdjudication } = deriveP6SwapPhase(gatedP6, segmentation, baskets, badges, config);
		expect(EXPECTED_IMPROVEMENT_PX).toBeGreaterThanOrEqual(20);
		expect(swapAdjudication.pairsConsidered).toBe(1);
		expect(swapAdjudication.swapsApplied).toBe(1);
		expect(swapAdjudication.changedHoleNumbers).toEqual([1, 2]);
		const finalHole1 = adjudicatedP6.assignments.find((a) => a.holeNumber === 1);
		const finalHole2 = adjudicatedP6.assignments.find((a) => a.holeNumber === 2);
		expect(finalHole1?.assignedBasketIndex).toBe(1);
		expect(finalHole2?.assignedBasketIndex).toBe(0);
	});

	it('the same improvement falls below a higher threshold and is NOT applied', () => {
		const config: P6Config = { forwardGateAngleDeg: 80, swap: { enabled: true, minRibbonImprovementPx: 30 } };
		expect(EXPECTED_IMPROVEMENT_PX).toBeLessThan(30);
		const { adjudicatedP6, swapAdjudication } = deriveP6SwapPhase(gatedP6, segmentation, baskets, badges, config);
		expect(swapAdjudication.swapsApplied).toBe(0);
		expect(swapAdjudication.changedHoleNumbers).toEqual([]);
		const finalHole1 = adjudicatedP6.assignments.find((a) => a.holeNumber === 1);
		expect(finalHole1?.assignedBasketIndex).toBe(0);
	});

	it('swap.enabled=false short-circuits to the documented empty result and passes the gated snapshot through unchanged', () => {
		const config: P6Config = { forwardGateAngleDeg: 80, swap: { enabled: false, minRibbonImprovementPx: 20 } };
		const { adjudicatedP6, swapAdjudication } = deriveP6SwapPhase(gatedP6, segmentation, baskets, badges, config);
		expect(swapAdjudication).toEqual({ pairsConsidered: 0, swapsApplied: 0, changedHoleNumbers: [], ms: 0, pairs: [] });
		expect(adjudicatedP6).toBe(gatedP6);
	});
});
