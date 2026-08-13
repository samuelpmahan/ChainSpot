import { describe, expect, it } from 'vitest';
import {
	collinearityStraightnessTest,
	fitOrthogonalLine,
	perpendicularDistanceToLine
} from '../../src/lib/autoAnnotation/collinearityStraightnessTest';
import type { SourcePoint } from '../../src/lib/domain/project';

describe('fitOrthogonalLine', () => {
	it('fits a 45-degree line through three exactly collinear points', () => {
		const line = fitOrthogonalLine([
			{ xPx: 0, yPx: 0 },
			{ xPx: 10, yPx: 10 },
			{ xPx: 20, yPx: 20 }
		]);
		expect(line.point).toEqual({ xPx: 10, yPx: 10 });
		// Direction is +/-45 degrees (unit vector, sign/orientation unconstrained).
		expect(Math.abs(line.direction.x)).toBeCloseTo(Math.SQRT1_2, 10);
		expect(Math.abs(line.direction.y)).toBeCloseTo(Math.SQRT1_2, 10);
		expect(line.direction.x * line.direction.y).toBeGreaterThan(0); // same sign: positive slope
	});

	it('fits an exactly vertical line without degenerating (unlike x-as-independent OLS)', () => {
		const points: SourcePoint[] = [
			{ xPx: 5, yPx: 0 },
			{ xPx: 5, yPx: 50 },
			{ xPx: 5, yPx: 100 }
		];
		const line = fitOrthogonalLine(points);
		expect(Number.isFinite(line.direction.x)).toBe(true);
		expect(Number.isFinite(line.direction.y)).toBe(true);
		expect(Math.abs(line.direction.x)).toBeCloseTo(0, 9);
		expect(Math.abs(line.direction.y)).toBeCloseTo(1, 9);
		for (const p of points) expect(Math.abs(perpendicularDistanceToLine(p, line))).toBeCloseTo(0, 9);
	});

	it('fits an exactly horizontal line', () => {
		const points: SourcePoint[] = [
			{ xPx: 0, yPx: 7 },
			{ xPx: 50, yPx: 7 },
			{ xPx: 100, yPx: 7 }
		];
		const line = fitOrthogonalLine(points);
		expect(Math.abs(line.direction.y)).toBeCloseTo(0, 9);
		expect(Math.abs(line.direction.x)).toBeCloseTo(1, 9);
	});

	it('throws on an empty point list', () => {
		expect(() => fitOrthogonalLine([])).toThrow();
	});
});

describe('collinearityStraightnessTest', () => {
	it('returns ~0 RMSE for three exactly collinear points (straight hole)', () => {
		const result = collinearityStraightnessTest({ xPx: 0, yPx: 0 }, { xPx: 50, yPx: 25 }, { xPx: 100, yPx: 50 });
		expect(result.rmse).toBeCloseTo(0, 9);
	});

	it('returns ~0 RMSE for three exactly collinear vertical points', () => {
		const result = collinearityStraightnessTest({ xPx: 5, yPx: 0 }, { xPx: 5, yPx: 40 }, { xPx: 5, yPx: 100 });
		expect(result.rmse).toBeCloseTo(0, 9);
	});

	it('matches a hand-computed RMSE for a badge offset perpendicular from the tee-basket line', () => {
		// tee=(0,0), basket=(100,0): a badge at (50, 20) sits 20px off that
		// segment. The TLS fit is over all three points (not just tee/basket),
		// so the fitted line is horizontal through the mean y (20/3), and the
		// closed-form RMSE works out to sqrt(2400/27) = 20*sqrt(2)/3.
		const result = collinearityStraightnessTest({ xPx: 0, yPx: 0 }, { xPx: 50, yPx: 20 }, { xPx: 100, yPx: 0 });
		expect(result.rmse).toBeCloseTo((20 * Math.sqrt(2)) / 3, 9);
		expect(Math.abs(result.line.direction.y)).toBeCloseTo(0, 9); // horizontal fit
	});

	it('produces a larger RMSE for a larger perpendicular badge offset, all else equal', () => {
		const small = collinearityStraightnessTest({ xPx: 0, yPx: 0 }, { xPx: 50, yPx: 5 }, { xPx: 100, yPx: 0 });
		const large = collinearityStraightnessTest({ xPx: 0, yPx: 0 }, { xPx: 50, yPx: 60 }, { xPx: 100, yPx: 0 });
		expect(large.rmse).toBeGreaterThan(small.rmse);
	});

	it('handles a near-vertical bent arrangement without NaN/Infinity (proves no x-as-independent-axis degeneracy)', () => {
		const result = collinearityStraightnessTest({ xPx: 100, yPx: 0 }, { xPx: 130, yPx: 50 }, { xPx: 100, yPx: 100 });
		expect(Number.isFinite(result.rmse)).toBe(true);
		expect(result.rmse).toBeGreaterThan(0);
	});
});

describe('perpendicularDistanceToLine', () => {
	it('is zero for a point exactly on the line', () => {
		const line = fitOrthogonalLine([
			{ xPx: 0, yPx: 0 },
			{ xPx: 10, yPx: 0 }
		]);
		expect(perpendicularDistanceToLine({ xPx: 5, yPx: 0 }, line)).toBeCloseTo(0, 9);
	});

	it('reports the correct magnitude for a point off a horizontal line', () => {
		const line = fitOrthogonalLine([
			{ xPx: 0, yPx: 0 },
			{ xPx: 10, yPx: 0 }
		]);
		expect(Math.abs(perpendicularDistanceToLine({ xPx: 3, yPx: 7 }, line))).toBeCloseTo(7, 9);
	});
});
