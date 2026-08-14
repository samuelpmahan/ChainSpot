import { describe, expect, it } from 'vitest';
import { detectCorridorBendsCapsuleRibbonMass } from '../../src/lib/autoAnnotation/corridorBendDetectionCapsuleRibbonMass';
import { buildModernCorridorEvidence, DEFAULT_CORRIDOR_EVIDENCE_GRID_PARAMS } from '../../src/lib/autoAnnotation/corridorEvidenceGridRibbonMass';
import type { RibbonMassSegmentationForEvidence } from '../../src/lib/autoAnnotation/corridorEvidenceGridRibbonMass';
import { fitCapsuleBends, DEFAULT_CAPSULE_FIT_PARAMS } from '../../src/lib/autoAnnotation/corridorBendDetectionCapsule';
import { labelComponents } from '../../src/lib/autoAnnotation/ribbonMass';
import type { SourcePoint } from '../../src/lib/domain/project';

/**
 * This module is a thin wire-up (arm D = `buildModernCorridorEvidence` +
 * `fitCapsuleBends`, both already exhaustively tested on their own) — these
 * tests exist to confirm the wiring itself, not to re-litigate either half's
 * own behavior. Same hand-built-segmentation fixture pattern as
 * `corridorEvidenceGridRibbonMass.test.ts`.
 */
function paintedSegmentation(
	widthEv: number,
	heightEv: number,
	scale: number,
	isOpen: (x: number, y: number) => boolean,
	evidenceAt: (x: number, y: number) => number
): RibbonMassSegmentationForEvidence {
	const binary = new Uint8Array(widthEv * heightEv);
	const evidence = new Float32Array(widthEv * heightEv);
	for (let y = 0; y < heightEv; y += 1) {
		for (let x = 0; x < widthEv; x += 1) {
			const open = isOpen(x, y);
			binary[y * widthEv + x] = open ? 1 : 0;
			evidence[y * widthEv + x] = evidenceAt(x, y);
		}
	}
	const labels = labelComponents(binary, widthEv, heightEv);
	return { widthEv, heightEv, scale, labels, evidence, textureKeptLabels: new Set<number>() };
}

const TEST_FIT_PARAMS = {
	...DEFAULT_CAPSULE_FIT_PARAMS,
	capsuleRadiusSrcPx: 12,
	lineSampleStepSrcPx: 3,
	minCapsulePixelCount: 5,
	minLineSampleCount: 3,
	structureHillClimbStepsSrcPx: [6, 3, 1],
	refinementHillClimbStepsSrcPx: [6, 3, 1]
};

describe('detectCorridorBendsCapsuleRibbonMass', () => {
	const tee: SourcePoint = { xPx: 20, yPx: 100 };
	const basket: SourcePoint = { xPx: 180, yPx: 100 };

	it('matches calling buildModernCorridorEvidence + fitCapsuleBends by hand, for a straight corridor', () => {
		const segmentation = paintedSegmentation(
			200,
			200,
			1,
			(x, y) => y >= 95 && y <= 105 && x >= 10 && x <= 190,
			(x, y) => (y >= 95 && y <= 105 && x >= 10 && x <= 190 ? 0.8 : 0)
		);
		const params = { evidence: DEFAULT_CORRIDOR_EVIDENCE_GRID_PARAMS, fit: TEST_FIT_PARAMS };

		const wired = detectCorridorBendsCapsuleRibbonMass(segmentation, tee, basket, undefined, [], params);

		const grid = buildModernCorridorEvidence(segmentation, tee, basket, undefined, [], params.evidence);
		const byHand = grid ? fitCapsuleBends(grid, tee, basket, undefined, params.fit) : [];

		expect(wired).toEqual(byHand);
		expect(wired).toEqual([]);
	});

	it('matches calling the two halves by hand for a genuine dogleg', () => {
		const isOpen = (x: number, y: number) => (x >= 10 && x <= 30 && y >= 10 && y <= 190) || (y >= 150 && y <= 190 && x >= 10 && x <= 190);
		const segmentation = paintedSegmentation(200, 200, 1, isOpen, (x, y) => (isOpen(x, y) ? 0.8 : 0));
		const doglegTee: SourcePoint = { xPx: 20, yPx: 30 };
		const doglegBasket: SourcePoint = { xPx: 170, yPx: 170 };
		const params = { evidence: DEFAULT_CORRIDOR_EVIDENCE_GRID_PARAMS, fit: TEST_FIT_PARAMS };

		const wired = detectCorridorBendsCapsuleRibbonMass(segmentation, doglegTee, doglegBasket, undefined, [], params);

		const grid = buildModernCorridorEvidence(segmentation, doglegTee, doglegBasket, undefined, [], params.evidence);
		const byHand = grid ? fitCapsuleBends(grid, doglegTee, doglegBasket, undefined, params.fit) : [];

		expect(wired).toEqual(byHand);
		expect(wired.length).toBeGreaterThanOrEqual(1);
	});

	it('returns [] rather than throwing when the crop window is degenerate (tee === basket)', () => {
		const segmentation = paintedSegmentation(10, 10, 1, () => true, () => 1);
		const params = {
			evidence: { ...DEFAULT_CORRIDOR_EVIDENCE_GRID_PARAMS, marginFraction: 0, minMarginPx: 0, maxMarginPx: 0 },
			fit: TEST_FIT_PARAMS
		};
		const degenerate: SourcePoint = { xPx: 5, yPx: 5 };
		expect(detectCorridorBendsCapsuleRibbonMass(segmentation, degenerate, degenerate, undefined, [], params)).toEqual([]);
	});
});
