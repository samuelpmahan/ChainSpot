import { describe, expect, it } from 'vitest';
import {
	DEFAULT_RIBBON_MASS_CORRIDOR_BEND_PARAMS,
	cropRibbonMassOpenWindow,
	detectCorridorBendsRibbonMass,
	keptLabelsForHole
} from '../../src/lib/autoAnnotation/corridorBendDetectionRibbonMass';
import type { RibbonMassSegmentationForBends } from '../../src/lib/autoAnnotation/corridorBendDetectionRibbonMass';
import { labelComponents } from '../../src/lib/autoAnnotation/ribbonMass';
import type { SourcePoint } from '../../src/lib/domain/project';

/**
 * Builds a synthetic `RibbonMassSegmentation`-shaped object by painting a
 * binary grid and running the real (exported) `labelComponents` over it —
 * the same pattern `corridorBendDetection.test.ts` uses (`paintRaster`), just
 * one abstraction layer up: a component-label map instead of raw RGBA. No
 * LANCZOS/box-mean/opening pipeline runs in these tests, so they stay fast
 * and deterministic; the real pixel pipeline is exercised only by the
 * separate benchmark script against real course imagery.
 */
function paintedSegmentation(
	widthEv: number,
	heightEv: number,
	scale: number,
	isOpen: (x: number, y: number) => boolean,
	textureKeepsEverythingPainted = false
): RibbonMassSegmentationForBends {
	const binary = new Uint8Array(widthEv * heightEv);
	for (let y = 0; y < heightEv; y += 1) {
		for (let x = 0; x < widthEv; x += 1) {
			binary[y * widthEv + x] = isOpen(x, y) ? 1 : 0;
		}
	}
	const labels = labelComponents(binary, widthEv, heightEv);
	const textureKeptLabels = new Set<number>();
	if (textureKeepsEverythingPainted) {
		for (const label of labels) if (label !== 0) textureKeptLabels.add(label);
	}
	return { widthEv, heightEv, scale, labels, textureKeptLabels };
}

describe('keptLabelsForHole', () => {
	it('admits the single component both tee and basket seeds land in', () => {
		const segmentation = paintedSegmentation(20, 20, 1, () => true);
		const kept = keptLabelsForHole(segmentation, { xPx: 2, yPx: 2 }, { xPx: 17, yPx: 17 }, 5);
		expect(kept.size).toBe(1);
		expect(kept.has(segmentation.labels[2 * 20 + 2])).toBe(true);
	});

	it('admits both components when tee and basket seeds land in different, disconnected components', () => {
		const segmentation = paintedSegmentation(
			20,
			20,
			1,
			(x, y) => (x < 5 && y < 5) || (x >= 15 && y >= 15)
		);
		const kept = keptLabelsForHole(segmentation, { xPx: 2, yPx: 2 }, { xPx: 17, yPx: 17 }, 3);
		expect(kept.size).toBe(2);
	});

	it('unions seed-connected components with the whole-course texture baseline', () => {
		const segmentation = paintedSegmentation(20, 20, 1, (x, y) => (x < 5 && y < 5) || (x >= 15 && y >= 15));
		// Manually mark a THIRD, seed-unrelated component as texture-admitted.
		const extra: RibbonMassSegmentationForBends = {
			...segmentation,
			textureKeptLabels: new Set([999])
		};
		const kept = keptLabelsForHole(extra, { xPx: 2, yPx: 2 }, { xPx: 17, yPx: 17 }, 3);
		expect(kept.has(999)).toBe(true);
		expect(kept.size).toBe(3);
	});

	it('returns an empty set when neither seed lands near any component', () => {
		const segmentation = paintedSegmentation(20, 20, 1, () => false);
		const kept = keptLabelsForHole(segmentation, { xPx: 2, yPx: 2 }, { xPx: 17, yPx: 17 }, 3);
		expect(kept.size).toBe(0);
	});
});

describe('cropRibbonMassOpenWindow', () => {
	it('marks cells open only when their label is in the kept set', () => {
		const segmentation = paintedSegmentation(10, 10, 1, (x) => x < 5);
		const keptLabel = segmentation.labels[0 * 10 + 0];
		const window = cropRibbonMassOpenWindow(segmentation, new Set([keptLabel]), { xPx: 1, yPx: 1 }, { xPx: 8, yPx: 8 }, {
			marginFraction: 0,
			minMarginPx: 0,
			maxMarginPx: 0
		});
		expect(window).not.toBeNull();
		// Window spans x in [1,8], y in [1,8] with zero margin -> width/height 7.
		expect(window!.widthPx).toBe(7);
		expect(window!.heightPx).toBe(7);
		// Source column x=1..3 (local x=0..2) is open (label matches); x=5..8 (local 4..7) is not.
		for (let localY = 0; localY < 7; localY += 1) {
			expect(window!.open[localY * 7 + 0]).toBe(1);
			expect(window!.open[localY * 7 + 6]).toBe(0);
		}
	});

	it('returns null for a degenerate (near-zero-area) window', () => {
		const segmentation = paintedSegmentation(10, 10, 1, () => true);
		const window = cropRibbonMassOpenWindow(segmentation, new Set([1]), { xPx: 5, yPx: 5 }, { xPx: 5, yPx: 5 }, {
			marginFraction: 0,
			minMarginPx: 0,
			maxMarginPx: 0
		});
		expect(window).toBeNull();
	});

	it('scales window origin/extent by the segmentation scale factor', () => {
		const segmentation = paintedSegmentation(10, 10, 3, () => true);
		const window = cropRibbonMassOpenWindow(segmentation, new Set([1]), { xPx: 3, yPx: 3 }, { xPx: 24, yPx: 24 }, {
			marginFraction: 0,
			minMarginPx: 0,
			maxMarginPx: 0
		});
		expect(window).not.toBeNull();
		expect(window!.scale).toBe(3);
		// Source px 3..24 / scale 3 -> evidence cells floor(1)..ceil(8) = [1, 8), width 7.
		expect(window!.originXPx).toBe(1 * 3);
		expect(window!.widthPx).toBe(7);
	});
});

describe('detectCorridorBendsRibbonMass', () => {
	const params = DEFAULT_RIBBON_MASS_CORRIDOR_BEND_PARAMS;

	it('proposes zero bends for a straight hole (uniformly open segmentation)', () => {
		const segmentation = paintedSegmentation(200, 200, 1, () => true);
		const bends = detectCorridorBendsRibbonMass(segmentation, { xPx: 20, yPx: 100 }, { xPx: 180, yPx: 100 }, params);
		expect(bends).toEqual([]);
	});

	// Same "L" shape as corridorBendDetection.test.ts's dogleg fixture: a
	// vertical leg near the left edge joined to a horizontal leg near the
	// bottom edge, forcing any connecting path to bend around the inner
	// corner near (30, 170).
	function doglegSegmentation(): RibbonMassSegmentationForBends {
		return paintedSegmentation(
			200,
			200,
			1,
			(x, y) => (x >= 10 && x <= 50 && y >= 10 && y <= 190) || (y >= 150 && y <= 190 && x >= 10 && x <= 190)
		);
	}
	const tee: SourcePoint = { xPx: 30, yPx: 30 };
	const basket: SourcePoint = { xPx: 170, yPx: 170 };

	it('proposes one or more bends clustered near the turn for a genuine dogleg', () => {
		const bends = detectCorridorBendsRibbonMass(doglegSegmentation(), tee, basket, params);
		expect(bends.length).toBeGreaterThanOrEqual(1);
		expect(bends.length).toBeLessThanOrEqual(3);
		for (const bend of bends) {
			expect(bend.xPx).toBeGreaterThanOrEqual(5);
			expect(bend.xPx).toBeLessThanOrEqual(155);
			expect(bend.yPx).toBeGreaterThanOrEqual(120);
			expect(bend.yPx).toBeLessThanOrEqual(195);
		}
	});

	it('suppresses the same dogleg bend when maxDetourRatio is tightened below the traced detour', () => {
		const bends = detectCorridorBendsRibbonMass(doglegSegmentation(), tee, basket, { ...params, maxDetourRatio: 1.05 });
		expect(bends).toEqual([]);
	});

	it('suppresses the same dogleg bend when minTurnAngleDeg is raised above the actual turn', () => {
		const bends = detectCorridorBendsRibbonMass(doglegSegmentation(), tee, basket, { ...params, minTurnAngleDeg: 95 });
		expect(bends).toEqual([]);
	});

	it('proposes zero bends when tee and basket sit in disconnected open components', () => {
		const segmentation = paintedSegmentation(
			200,
			200,
			1,
			(x, y) => (x >= 10 && x <= 50 && y >= 10 && y <= 50) || (x >= 150 && x <= 190 && y >= 150 && y <= 190)
		);
		const bends = detectCorridorBendsRibbonMass(segmentation, { xPx: 30, yPx: 30 }, { xPx: 170, yPx: 170 }, params);
		expect(bends).toEqual([]);
	});

	it('proposes zero bends when tee or basket falls outside the segmentation bounds', () => {
		const segmentation = paintedSegmentation(50, 50, 1, () => true);
		const bends = detectCorridorBendsRibbonMass(segmentation, { xPx: -5, yPx: 10 }, { xPx: 40, yPx: 40 }, params);
		expect(bends).toEqual([]);
	});

	it('proposes zero bends when the kept set is empty (no seed hit, no texture admission)', () => {
		const segmentation = paintedSegmentation(200, 200, 1, () => false);
		const bends = detectCorridorBendsRibbonMass(segmentation, tee, basket, params);
		expect(bends).toEqual([]);
	});
});
