import { describe, expect, it } from 'vitest';
import {
	basketIsPlausibleInteriorTransit,
	routeLeg
} from '../../src/lib/autoAnnotation/middleOutRibbon';

describe('MiddleOut basket transit policy', () => {
	it('uses the semantic chord only as an interior-crossing confidence shortcut', () => {
		const start = { xPx: 0, yPx: 20 };
		const goal = { xPx: 100, yPx: 20 };

		expect(
			basketIsPlausibleInteriorTransit({ xPx: 34, yPx: 20 }, start, goal)
		).toBe(true);
		expect(
			basketIsPlausibleInteriorTransit({ xPx: 86, yPx: 20 }, start, goal)
		).toBe(false);
		expect(
			basketIsPlausibleInteriorTransit({ xPx: 50, yPx: 70 }, start, goal)
		).toBe(false);
	});

	it('keeps a true mid-leg basket crossing open but softly routes around an endpoint distractor', () => {
		const width = 101;
		const height = 61;
		const start = { xPx: 5, yPx: 30 };
		const goal = { xPx: 95, yPx: 30 };
		const cost = new Float32Array(width * height).fill(1);

		const midLeg = { xPx: 50, yPx: 30 };
		const allowed = routeLeg(cost, width, height, 1, start, goal, {
			basketTransit: {
				basketCentersSrcPx: [midLeg],
				spriteRadiusSrcPx: 6,
				crossingHalfWidthSrcPx: 6,
				interiorFraction: 0.2,
				distractorPenalty: 100
			}
		});
		expect(allowed).not.toBeNull();
		expect(
			Math.min(...allowed!.map((point) => Math.hypot(point.xPx - midLeg.xPx, point.yPx - midLeg.yPx)))
		).toBeLessThanOrEqual(1);

		const endpointDistractor = { xPx: 15, yPx: 30 };
		const discouraged = routeLeg(cost, width, height, 1, start, goal, {
			basketTransit: {
				basketCentersSrcPx: [endpointDistractor],
				spriteRadiusSrcPx: 6,
				crossingHalfWidthSrcPx: 6,
				interiorFraction: 0.2,
				distractorPenalty: 100
			}
		});
		expect(discouraged).not.toBeNull();
		expect(
			Math.min(
				...discouraged!.map((point) =>
					Math.hypot(point.xPx - endpointDistractor.xPx, point.yPx - endpointDistractor.yPx)
				)
			)
		).toBeGreaterThanOrEqual(5);
	});
});
