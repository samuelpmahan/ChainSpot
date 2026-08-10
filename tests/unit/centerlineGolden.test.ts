import { describe, expect, it } from 'vitest';
import { checkStraightness, compareToGoldenShape, resamplePolyline } from '../../src/lib/autoAnnotation/centerlineGolden';

describe('resamplePolyline', () => {
	it('resamples an L-shaped polyline to even arc-length spacing', () => {
		const points = [
			{ xPx: 0, yPx: 0 },
			{ xPx: 10, yPx: 0 },
			{ xPx: 10, yPx: 10 }
		];
		const resampled = resamplePolyline(points, 5);
		expect(resampled).toHaveLength(5);
		expect(resampled[0]).toEqual({ xPx: 0, yPx: 0 });
		expect(resampled[4]).toEqual({ xPx: 10, yPx: 10 });
		// Total length 20, so the midpoint (distance 10) lands exactly at the corner.
		expect(resampled[2].xPx).toBeCloseTo(10, 5);
		expect(resampled[2].yPx).toBeCloseTo(0, 5);
	});

	it('produces the same point count regardless of the input point count', () => {
		const sparse = [
			{ xPx: 0, yPx: 0 },
			{ xPx: 100, yPx: 0 }
		];
		const dense = Array.from({ length: 50 }, (_, i) => ({ xPx: (i / 49) * 100, yPx: 0 }));
		const a = resamplePolyline(sparse, 10);
		const b = resamplePolyline(dense, 10);
		for (let i = 0; i < 10; i += 1) {
			expect(a[i].xPx).toBeCloseTo(b[i].xPx, 5);
		}
	});
});

describe('compareToGoldenShape', () => {
	it('accepts a shape that matches within tolerance despite a different point count', () => {
		const golden = [
			{ xPx: 0, yPx: 0 },
			{ xPx: 50, yPx: 0 },
			{ xPx: 100, yPx: 50 }
		];
		const traced = [
			{ xPx: 0, yPx: 0 },
			{ xPx: 25, yPx: 0 },
			{ xPx: 50, yPx: 0.5 },
			{ xPx: 75, yPx: 25 },
			{ xPx: 100, yPx: 50 }
		];
		const result = compareToGoldenShape(traced, golden, 5);
		expect(result.withinTolerance).toBe(true);
	});

	it('rejects a shape that diverges beyond tolerance, e.g. locking onto the wrong ring', () => {
		const golden = [
			{ xPx: 0, yPx: 0 },
			{ xPx: 50, yPx: 0 },
			{ xPx: 100, yPx: 50 }
		];
		const shifted = golden.map((p) => ({ xPx: p.xPx, yPx: p.yPx + 40 }));
		const result = compareToGoldenShape(shifted, golden, 5);
		expect(result.withinTolerance).toBe(false);
		expect(result.maxDistancePx).toBeGreaterThan(30);
	});
});

describe('checkStraightness', () => {
	it('accepts a straight line', () => {
		const points = Array.from({ length: 10 }, (_, i) => ({ xPx: i * 10, yPx: 100 }));
		const result = checkStraightness(points, 0.1);
		expect(result.withinTolerance).toBe(true);
		expect(result.deviationFraction).toBeCloseTo(0, 5);
	});

	it('accepts a small kink (e.g. routing around a number badge) within a generous tolerance', () => {
		const points = [
			{ xPx: 0, yPx: 100 },
			{ xPx: 40, yPx: 100 },
			{ xPx: 50, yPx: 90 }, // a one-point kink
			{ xPx: 60, yPx: 100 },
			{ xPx: 100, yPx: 100 }
		];
		const result = checkStraightness(points, 0.15);
		expect(result.withinTolerance).toBe(true);
	});

	it('rejects a real dogleg', () => {
		const points = [
			{ xPx: 0, yPx: 100 },
			{ xPx: 50, yPx: 100 },
			{ xPx: 50, yPx: 40 },
			{ xPx: 100, yPx: 40 }
		];
		const result = checkStraightness(points, 0.15);
		expect(result.withinTolerance).toBe(false);
	});
});
