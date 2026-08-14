import { describe, expect, it } from 'vitest';
import {
	DEFAULT_CAPSULE_FIT_PARAMS,
	DEFAULT_CLASSIC_CORRIDOR_EVIDENCE_PARAMS,
	buildClassicCorridorEvidence,
	detectCorridorBendsCapsule,
	fitCapsuleBends
} from '../../src/lib/autoAnnotation/corridorBendDetectionCapsule';
import type { CapsuleFitParams } from '../../src/lib/autoAnnotation/corridorBendDetectionCapsule';
import type { CorridorBendRaster } from '../../src/lib/autoAnnotation/corridorBendDetection';
import type { CorridorEvidenceGrid } from '../../src/lib/autoAnnotation/corridorEvidenceGrid';
import type { SourcePoint } from '../../src/lib/domain/project';

// Smaller-scale params tailored to compact synthetic grids (the defaults'
// 21px capsule radius / 18,9,3px + 24,12,6,3px hill-climb steps are sized for
// real, larger crops — see the module doc comment's PYTHON_EVIDENCE_SCALE
// derivation). Mirrors `corridorBendDetectionRibbon.test.ts`'s own
// TEST_PARAMS convention for the same reason.
const TEST_PARAMS: CapsuleFitParams = {
	...DEFAULT_CAPSULE_FIT_PARAMS,
	capsuleRadiusSrcPx: 12,
	lineSampleStepSrcPx: 3,
	minCapsulePixelCount: 5,
	minLineSampleCount: 3,
	structureHillClimbStepsSrcPx: [6, 3, 1],
	refinementHillClimbStepsSrcPx: [6, 3, 1]
};

function paintEvidenceGrid(widthPx: number, heightPx: number, valueAt: (x: number, y: number) => number): CorridorEvidenceGrid {
	const evidence = new Float32Array(widthPx * heightPx);
	for (let y = 0; y < heightPx; y += 1) {
		for (let x = 0; x < widthPx; x += 1) evidence[y * widthPx + x] = valueAt(x, y);
	}
	return { widthPx, heightPx, originXPx: 0, originYPx: 0, scale: 1, evidence };
}

describe('fitCapsuleBends', () => {
	describe('straight corridor', () => {
		const width = 260;
		const height = 200;
		const halfWidth = 30;
		const tee: SourcePoint = { xPx: 20, yPx: 100 };
		const basket: SourcePoint = { xPx: 240, yPx: 100 };
		const grid = paintEvidenceGrid(width, height, (x, y) => (Math.abs(y - 100) <= halfWidth ? 1 : 0));

		it('proposes zero bends, unanchored', () => {
			expect(fitCapsuleBends(grid, tee, basket, undefined, TEST_PARAMS)).toEqual([]);
		});

		it('proposes zero bends, anchored at a badge sitting on the corridor centerline', () => {
			const badge: SourcePoint = { xPx: 100, yPx: 100 };
			expect(fitCapsuleBends(grid, tee, basket, badge, TEST_PARAMS)).toEqual([]);
		});

		it('proposes zero bends when tee or basket falls outside the grid', () => {
			expect(fitCapsuleBends(grid, { xPx: -5, yPx: 100 }, basket, undefined, TEST_PARAMS)).toEqual([]);
		});

		it('falls back to the unanchored fit when the badge itself falls outside the grid', () => {
			const offGridBadge: SourcePoint = { xPx: 5000, yPx: 5000 };
			const anchored = fitCapsuleBends(grid, tee, basket, offGridBadge, TEST_PARAMS);
			const unanchored = fitCapsuleBends(grid, tee, basket, undefined, TEST_PARAMS);
			expect(anchored).toEqual(unanchored);
		});
	});

	// Same "L" shape as corridorBendDetection.test.ts's dogleg fixture: a
	// vertical leg near the left edge joined to a horizontal leg near the
	// bottom edge. The direct tee-basket diagonal crosses a large stretch of
	// off-corridor background (see the module comment history/derivation
	// this test's geometry was checked against), so any straight capsule
	// scores far below a capsule that bends around the inner corner.
	function doglegGrid(): CorridorEvidenceGrid {
		const width = 200;
		const height = 200;
		return paintEvidenceGrid(width, height, (x, y) => ((x >= 10 && x <= 50 && y >= 10 && y <= 190) || (y >= 150 && y <= 190 && x >= 10 && x <= 190) ? 1 : 0));
	}
	const doglegTee: SourcePoint = { xPx: 30, yPx: 30 };
	const doglegBasket: SourcePoint = { xPx: 170, yPx: 170 };

	it('proposes one or more bends clustered near the turn for a genuine dogleg, unanchored', () => {
		const bends = fitCapsuleBends(doglegGrid(), doglegTee, doglegBasket, undefined, TEST_PARAMS);
		expect(bends.length).toBeGreaterThanOrEqual(1);
		expect(bends.length).toBeLessThanOrEqual(3);
		for (const bend of bends) {
			expect(bend.xPx).toBeGreaterThanOrEqual(5);
			expect(bend.xPx).toBeLessThanOrEqual(155);
			expect(bend.yPx).toBeGreaterThanOrEqual(120);
			expect(bend.yPx).toBeLessThanOrEqual(195);
		}
	});

	it('anchoring the badge AT the true corner absorbs it into the fixed segment: zero bends where the unanchored fit needed one', () => {
		// tee->badge is a straight vertical run fully inside the vertical leg;
		// badge->basket is a straight horizontal run fully inside the
		// horizontal leg -- perfect capsule coverage either way, so no
		// additional bend is worth its length penalty. Mirrors the Python
		// probe's own "the anchor fixes hole 18 structurally... the badge IS
		// the first bend" finding (see this module's doc comment).
		const badge: SourcePoint = { xPx: 30, yPx: 170 };
		const bends = fitCapsuleBends(doglegGrid(), doglegTee, doglegBasket, badge, TEST_PARAMS);
		expect(bends).toEqual([]);
	});

	describe('badge-box masking', () => {
		// Straight corridor (as above) with a dark "badge glyph" occlusion
		// carved into the evidence directly under where the badge sits,
		// shifted toward the corridor's upper edge so a capsule centered on
		// the straight chord partially overlaps it.
		const width = 260;
		const height = 200;
		const halfWidth = 30;
		const tee: SourcePoint = { xPx: 20, yPx: 100 };
		const basket: SourcePoint = { xPx: 240, yPx: 100 };
		const badge: SourcePoint = { xPx: 100, yPx: 100 };
		const occluderX: readonly [number, number] = [70, 130];
		const occluderY: readonly [number, number] = [70, 101];
		function gridWithOccluder(): CorridorEvidenceGrid {
			return paintEvidenceGrid(width, height, (x, y) => {
				if (x >= occluderX[0] && x <= occluderX[1] && y >= occluderY[0] && y <= occluderY[1]) return 0;
				return Math.abs(y - 100) <= halfWidth ? 1 : 0;
			});
		}

		it('excludes the badge-box occlusion from scoring, so an otherwise-straight hole still resolves to zero bends', () => {
			const bends = fitCapsuleBends(gridWithOccluder(), tee, basket, badge, TEST_PARAMS);
			expect(bends).toEqual([]);
		});

		it('the same occlusion, scored WITHOUT masking (badge mask shrunk to a single cell), is enough to change the result', () => {
			const maskedResult = fitCapsuleBends(gridWithOccluder(), tee, basket, badge, TEST_PARAMS);
			const unmaskedParams: CapsuleFitParams = { ...TEST_PARAMS, badgeMaskHalfWidthSrcPx: 0.4, badgeMaskHalfHeightSrcPx: 0.4 };
			const unmaskedResult = fitCapsuleBends(gridWithOccluder(), tee, basket, badge, unmaskedParams);
			// With the occlusion no longer excluded, the fit is measurably
			// perturbed relative to the masked (correct) result -- either a
			// spurious bend appears, or (at minimum) the geometry differs.
			expect(unmaskedResult).not.toEqual(maskedResult);
		});
	});
});

describe('buildClassicCorridorEvidence', () => {
	function paintRaster(widthPx: number, heightPx: number, colorAt: (x: number, y: number) => readonly [number, number, number]): CorridorBendRaster {
		const data = new Uint8ClampedArray(widthPx * heightPx * 4);
		for (let y = 0; y < heightPx; y += 1) {
			for (let x = 0; x < widthPx; x += 1) {
				const [r, g, b] = colorAt(x, y);
				const p = (y * widthPx + x) * 4;
				data[p] = r;
				data[p + 1] = g;
				data[p + 2] = b;
				data[p + 3] = 255;
			}
		}
		return { widthPx, heightPx, originXPx: 0, originYPx: 0, scale: 1, data, channels: 4 };
	}

	it('reads zero evidence everywhere for a uniform-brightness raster (no local brightening to detect)', () => {
		const raster = paintRaster(120, 120, () => [128, 128, 128]);
		const grid = buildClassicCorridorEvidence(raster, { xPx: 10, yPx: 10 }, { xPx: 110, yPx: 110 }, DEFAULT_CLASSIC_CORRIDOR_EVIDENCE_PARAMS);
		expect(Array.from(grid.evidence).every((v) => v === 0)).toBe(true);
	});

	it('reads high evidence inside a bright band and near-zero well outside it, over darker surrounding terrain', () => {
		const width = 200;
		const height = 200;
		const isBand = (x: number, y: number) => Math.abs(y - 100) <= 15;
		const raster = paintRaster(width, height, (x, y) => (isBand(x, y) ? [220, 220, 220] : [60, 60, 60]));
		const params = { ...DEFAULT_CLASSIC_CORRIDOR_EVIDENCE_PARAMS, boxMeanWindowSrcPx: 61 };
		const grid = buildClassicCorridorEvidence(raster, { xPx: 20, yPx: 100 }, { xPx: 180, yPx: 100 }, params);
		const at = (x: number, y: number) => grid.evidence[y * width + x];
		expect(at(100, 100)).toBeGreaterThan(0.5);
		expect(at(100, 10)).toBeLessThan(0.2);
		expect(at(100, 190)).toBeLessThan(0.2);
	});

	it('returns an all-zero evidence grid when tee or basket falls outside the raster', () => {
		const raster = paintRaster(50, 50, () => [128, 128, 128]);
		const grid = buildClassicCorridorEvidence(raster, { xPx: -5, yPx: 10 }, { xPx: 40, yPx: 40 }, DEFAULT_CLASSIC_CORRIDOR_EVIDENCE_PARAMS);
		expect(Array.from(grid.evidence).every((v) => v === 0)).toBe(true);
	});
});

describe('detectCorridorBendsCapsule', () => {
	function paintRaster(widthPx: number, heightPx: number, colorAt: (x: number, y: number) => readonly [number, number, number]): CorridorBendRaster {
		const data = new Uint8ClampedArray(widthPx * heightPx * 4);
		for (let y = 0; y < heightPx; y += 1) {
			for (let x = 0; x < widthPx; x += 1) {
				const [r, g, b] = colorAt(x, y);
				const p = (y * widthPx + x) * 4;
				data[p] = r;
				data[p + 1] = g;
				data[p + 2] = b;
				data[p + 3] = 255;
			}
		}
		return { widthPx, heightPx, originXPx: 0, originYPx: 0, scale: 1, data, channels: 4 };
	}
	const detectParams = { evidence: { ...DEFAULT_CLASSIC_CORRIDOR_EVIDENCE_PARAMS, boxMeanWindowSrcPx: 61 }, fit: TEST_PARAMS };

	it('proposes zero bends for a straight, uniformly bright corridor over darker terrain', () => {
		const width = 260;
		const height = 200;
		const isBand = (x: number, y: number) => Math.abs(y - 100) <= 20;
		const raster = paintRaster(width, height, (x, y) => (isBand(x, y) ? [220, 220, 220] : [60, 60, 60]));
		const bends = detectCorridorBendsCapsule(raster, { xPx: 20, yPx: 100 }, { xPx: 240, yPx: 100 }, undefined, detectParams);
		expect(bends).toEqual([]);
	});

	it('proposes one or more bends for a genuine dogleg corridor', () => {
		const width = 200;
		const height = 200;
		const isBand = (x: number, y: number) => (x >= 10 && x <= 50 && y >= 10 && y <= 190) || (y >= 150 && y <= 190 && x >= 10 && x <= 190);
		const raster = paintRaster(width, height, (x, y) => (isBand(x, y) ? [220, 220, 220] : [60, 60, 60]));
		const bends = detectCorridorBendsCapsule(raster, { xPx: 30, yPx: 30 }, { xPx: 170, yPx: 170 }, undefined, detectParams);
		expect(bends.length).toBeGreaterThanOrEqual(1);
		expect(bends.length).toBeLessThanOrEqual(3);
	});
});
