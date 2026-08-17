import { describe, expect, it } from 'vitest';
import {
	BASKET_SPRITE_TIP_OFFSET_PX,
	buildPancakeDisplayGrammar
} from '../../src/lib/autoAnnotation/pancakeCourseDisplay';
import type { RawObjectMaskResult } from '../../src/lib/autoAnnotation/rawObjectMask';
import type { HoleNumberDetection } from '../../src/lib/autoAnnotation/holeNumberDetection';
import type { P5SparseAssignmentResult } from '../../src/lib/autoAnnotation/p5SparseAssignment';
import type { P6LowParBasketAssignmentResult } from '../../src/lib/autoAnnotation/p6LowParBasketAssignment';

describe('pancake basket semantic anchor', () => {
	it('publishes the sprite tip while preserving the raw P1 localization for ownership', () => {
		const rawBasket = {
			xPx: 1323.5,
			yPx: 1434,
			centerXPx: 1323.5,
			centerYPx: 1396.315,
			widthPx: 42,
			heightPx: 66,
			areaPx: 1746,
			fill: 1746 / (42 * 66)
		};
		const rawMaskObjects = {
			tees: [
				{
					xPx: 1948.5,
					yPx: 1450.6,
					orientationDeg: 0,
					widthPx: 20,
					heightPx: 10,
					areaPx: 100,
					fill: 0.5
				}
			],
			badges: [],
			baskets: [rawBasket],
			diagnostics: {
				brightComponentCount: 1,
				darkComponentCount: 1,
				basketShapePoolCount: 1,
				badgeShapePoolCount: 1,
				thresholds: { brightValueMin: 210, brightSaturationMax: 45, darkValueMax: 45 }
			}
		} as unknown as RawObjectMaskResult;
		const numbers = {
			candidates: [{ label: 4, xPx: 1900, yPx: 1450, glyphScore: 0.99 }]
		} as unknown as HoleNumberDetection;
		const p5 = {
			assignments: [
				{ status: 'assigned', assignedHoleNumber: 4, teeIndex: 0, assignedAxisErrorPx: 0 }
			]
		} as unknown as P5SparseAssignmentResult;
		const p6 = {
			assignments: [{ status: 'lowParAssigned', holeNumber: 4, assignedBasketIndex: 0 }]
		} as unknown as P6LowParBasketAssignmentResult;

		const grammar = buildPancakeDisplayGrammar(rawMaskObjects, numbers, p5, p6);
		const hole4 = grammar.holes.find((hole) => hole.number === 4);

		expect(BASKET_SPRITE_TIP_OFFSET_PX).toBe(4);
		expect(rawMaskObjects.baskets[0].yPx).toBe(1434);
		expect(hole4?.basket?.xPx).toBe(1323.5);
		expect(hole4?.basket?.yPx).toBe(1438);
	});
});
