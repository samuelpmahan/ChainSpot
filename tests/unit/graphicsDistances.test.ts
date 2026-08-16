import { describe, expect, it } from 'vitest';
import { computeHoleDistances } from '../../src/lib/graphics/distances';
import type { HoleGraphicPlan } from '../../src/lib/holeGraphics';

const CROP = { xPx: 0, yPx: 0, widthPx: 400, heightPx: 400 };

function planFor(overrides: Partial<HoleGraphicPlan>): HoleGraphicPlan {
	return {
		holeId: 'hole-1',
		number: 1,
		tee: null,
		basket: null,
		shots: [],
		corridorBand: null,
		centerline: [],
		bends: [],
		walkingPath: [],
		crop: CROP,
		targetWidthPx: 400,
		targetHeightPx: 400,
		targetRotationDeg: 0,
		...overrides
	};
}

describe('computeHoleDistances', () => {
	it('computes hole length and distance-to-pin from the last shot when shots exist', () => {
		const plan = planFor({
			tee: { xPx: 0, yPx: 0 },
			basket: { xPx: 300, yPx: 0 },
			shots: [
				{ xPx: 100, yPx: 0 },
				{ xPx: 220, yPx: 0 }
			]
		});

		const distances = computeHoleDistances(plan, 2);

		expect(distances.lengthFt).toBe(600); // 300px * 2ft/px
		expect(distances.distanceToPinFt).toBe(160); // (300-220)px * 2ft/px
	});

	it('falls back to the tee as the current lie when there are no shots yet', () => {
		const plan = planFor({
			tee: { xPx: 0, yPx: 0 },
			basket: { xPx: 300, yPx: 400 }
		});

		const distances = computeHoleDistances(plan, 1);

		expect(distances.lengthFt).toBe(500); // 3-4-5 triangle
		expect(distances.distanceToPinFt).toBe(500);
	});

	it('returns null for either metric when the required points are missing', () => {
		expect(computeHoleDistances(planFor({ basket: { xPx: 0, yPx: 0 } }), 1)).toEqual({
			lengthFt: null,
			distanceToPinFt: null
		});
		expect(computeHoleDistances(planFor({ tee: { xPx: 0, yPx: 0 } }), 1)).toEqual({
			lengthFt: null,
			distanceToPinFt: null
		});
	});
});
