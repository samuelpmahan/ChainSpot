import { describe, expect, test } from 'vitest';
import {
	evaluateStrongHoles,
	STRONG_DIVERGENCE_MAX,
	type StrongHoleInput,
	type StrongHoleVerdict
} from '@chainspot/alg/detectors/strongHole';

describe('evaluateStrongHoles', () => {
	test('perfectly collinear points (tee-badge-basket in a line) â†’ divergence near 0, strong', () => {
		const holes: StrongHoleInput[] = [
			{
				n: 1,
				badge: { xPx: 50, yPx: 50 }, // Midpoint on the line
				tee: { xPx: 0, yPx: 0 },
				basket: { xPx: 100, yPx: 100 },
				bends: []
			}
		];

		const result = evaluateStrongHoles(holes);
		expect(result).toHaveLength(1);
		expect(result[0].n).toBe(1);
		expect(result[0].divergence).toBeDefined();
		expect(result[0].divergence!).toBeLessThan(0.001);
		expect(result[0].strong).toBe(true);
	});

	test('clearly divergent triple (~2.4% RMSE ratio) â†’ not strong', () => {
		// Tee at (0, 0), basket at (100, 0), badge at (50, 5)
		// The fitted line minimizes perpendicular distance of all three points
		// RMSE will be dominated by badge's offset, normalized by hole length
		const holes: StrongHoleInput[] = [
			{
				n: 2,
				badge: { xPx: 50, yPx: 5 },
				tee: { xPx: 0, yPx: 0 },
				basket: { xPx: 100, yPx: 0 },
				bends: []
			}
		];

		const result = evaluateStrongHoles(holes);
		expect(result[0].n).toBe(2);
		expect(result[0].divergence).toBeDefined();
		expect(result[0].divergence!).toBeGreaterThan(0.015); // > threshold
		expect(result[0].strong).toBe(false);
	});

	test('just under threshold â†’ strong', () => {
		// Tee at (0, 0), basket at (1000, 0), badge at (500, 30)
		// RMSE ~14.1, divergence ~0.0141 < 0.015
		const holes: StrongHoleInput[] = [
			{
				n: 3,
				badge: { xPx: 500, yPx: 30 },
				tee: { xPx: 0, yPx: 0 },
				basket: { xPx: 1000, yPx: 0 },
				bends: []
			}
		];

		const result = evaluateStrongHoles(holes);
		expect(result[0].divergence).toBeDefined();
		expect(result[0].divergence!).toBeLessThan(0.015);
		expect(result[0].strong).toBe(true);
	});

	test('just over threshold â†’ not strong', () => {
		// Tee at (0, 0), basket at (1000, 0), badge at (500, 35)
		// RMSE ~16.5, divergence ~0.0165 > 0.015
		const holes: StrongHoleInput[] = [
			{
				n: 4,
				badge: { xPx: 500, yPx: 35 },
				tee: { xPx: 0, yPx: 0 },
				basket: { xPx: 1000, yPx: 0 },
				bends: []
			}
		];

		const result = evaluateStrongHoles(holes);
		expect(result[0].divergence).toBeDefined();
		expect(result[0].divergence!).toBeGreaterThan(0.015);
		expect(result[0].strong).toBe(false);
	});

	test('bends present â†’ not strong even if collinear', () => {
		const holes: StrongHoleInput[] = [
			{
				n: 5,
				badge: { xPx: 50, yPx: 50 },
				tee: { xPx: 0, yPx: 0 },
				basket: { xPx: 100, yPx: 100 },
				bends: [{ xPx: 60, yPx: 40 }] // Single bend point
			}
		];

		const result = evaluateStrongHoles(holes);
		expect(result[0].n).toBe(5);
		expect(result[0].divergence).toBeNull();
		expect(result[0].strong).toBe(false);
	});

	test('missing tee â†’ divergence null, not strong', () => {
		const holes: StrongHoleInput[] = [
			{
				n: 6,
				badge: { xPx: 50, yPx: 50 },
				tee: null,
				basket: { xPx: 100, yPx: 100 },
				bends: []
			}
		];

		const result = evaluateStrongHoles(holes);
		expect(result[0].n).toBe(6);
		expect(result[0].divergence).toBeNull();
		expect(result[0].strong).toBe(false);
	});

	test('missing basket â†’ divergence null, not strong', () => {
		const holes: StrongHoleInput[] = [
			{
				n: 7,
				badge: { xPx: 50, yPx: 50 },
				tee: { xPx: 0, yPx: 0 },
				basket: null,
				bends: []
			}
		];

		const result = evaluateStrongHoles(holes);
		expect(result[0].n).toBe(7);
		expect(result[0].divergence).toBeNull();
		expect(result[0].strong).toBe(false);
	});

	test('tee coincides with badge â†’ divergence null, not strong', () => {
		const holes: StrongHoleInput[] = [
			{
				n: 8,
				badge: { xPx: 0, yPx: 0 }, // Same as tee
				tee: { xPx: 0, yPx: 0 },
				basket: { xPx: 100, yPx: 100 },
				bends: []
			}
		];

		const result = evaluateStrongHoles(holes);
		expect(result[0].n).toBe(8);
		expect(result[0].divergence).toBeNull();
		expect(result[0].strong).toBe(false);
	});

	test('tee coincides with basket â†’ divergence null, not strong', () => {
		const holes: StrongHoleInput[] = [
			{
				n: 9,
				badge: { xPx: 50, yPx: 50 },
				tee: { xPx: 100, yPx: 100 },
				basket: { xPx: 100, yPx: 100 }, // Same as tee
				bends: []
			}
		];

		const result = evaluateStrongHoles(holes);
		expect(result[0].n).toBe(9);
		expect(result[0].divergence).toBeNull();
		expect(result[0].strong).toBe(false);
	});

	test('zero-length tee-basket â†’ divergence null, not strong, no NaN', () => {
		const holes: StrongHoleInput[] = [
			{
				n: 10,
				badge: { xPx: 50, yPx: 50 },
				tee: { xPx: 100, yPx: 100 },
				basket: { xPx: 100, yPx: 100 }, // Zero distance from tee
				bends: []
			}
		];

		const result = evaluateStrongHoles(holes);
		expect(result[0].n).toBe(10);
		expect(result[0].divergence).toBeNull();
		expect(result[0].strong).toBe(false);
		expect(Number.isNaN(result[0].divergence)).toBe(false);
	});

	test('custom divergenceMax parameter respected', () => {
		const holes: StrongHoleInput[] = [
			{
				n: 11,
				badge: { xPx: 500, yPx: 25 }, // ~1.2% RMSE ratio on 1000-unit hole
				tee: { xPx: 0, yPx: 0 },
				basket: { xPx: 1000, yPx: 0 },
				bends: []
			}
		];

		// Compute the actual divergence
		const resultDefault = evaluateStrongHoles(holes);
		const divergence = resultDefault[0].divergence!;
		expect(divergence).toBeLessThan(0.015);
		expect(divergence).toBeGreaterThan(0.01);

		// With default threshold (0.015), should be strong (divergence is between 0.01 and 0.015)
		expect(resultDefault[0].strong).toBe(true);

		// With looser threshold (0.02), should definitely be strong
		const resultLoose = evaluateStrongHoles(holes, 0.02);
		expect(resultLoose[0].strong).toBe(true);

		// With tighter threshold (0.01), should not be strong (divergence > 0.01)
		const resultTight = evaluateStrongHoles(holes, 0.01);
		expect(resultTight[0].strong).toBe(false);
	});

	test('batch processing multiple holes with mixed results', () => {
		const holes: StrongHoleInput[] = [
			{
				n: 1,
				badge: { xPx: 50, yPx: 50 },
				tee: { xPx: 0, yPx: 0 },
				basket: { xPx: 100, yPx: 100 },
				bends: []
			},
			{
				n: 2,
				badge: { xPx: 50, yPx: 5 },
				tee: { xPx: 0, yPx: 0 },
				basket: { xPx: 100, yPx: 0 },
				bends: []
			},
			{
				n: 3,
				badge: { xPx: 50, yPx: 50 },
				tee: null,
				basket: { xPx: 100, yPx: 100 },
				bends: []
			}
		];

		const results = evaluateStrongHoles(holes);
		expect(results).toHaveLength(3);

		// Hole 1: collinear, strong
		expect(results[0].n).toBe(1);
		expect(results[0].strong).toBe(true);

		// Hole 2: divergent, not strong
		expect(results[1].n).toBe(2);
		expect(results[1].strong).toBe(false);

		// Hole 3: missing tee, not strong
		expect(results[2].n).toBe(3);
		expect(results[2].divergence).toBeNull();
		expect(results[2].strong).toBe(false);
	});

	test('diagonal line: collinear points at various positions', () => {
		// Diagonal from (0, 0) to (100, 100)
		const holes: StrongHoleInput[] = [
			{
				n: 12,
				badge: { xPx: 25, yPx: 25 }, // On line
				tee: { xPx: 0, yPx: 0 },
				basket: { xPx: 100, yPx: 100 },
				bends: []
			},
			{
				n: 13,
				badge: { xPx: 75, yPx: 75 }, // On line
				tee: { xPx: 0, yPx: 0 },
				basket: { xPx: 100, yPx: 100 },
				bends: []
			}
		];

		const results = evaluateStrongHoles(holes);
		expect(results[0].strong).toBe(true);
		expect(results[1].strong).toBe(true);
		expect(results[0].divergence!).toBeLessThan(0.001);
		expect(results[1].divergence!).toBeLessThan(0.001);
	});

	test('vertical hole', () => {
		const holes: StrongHoleInput[] = [
			{
				n: 14,
				badge: { xPx: 0, yPx: 50 }, // On line
				tee: { xPx: 0, yPx: 0 },
				basket: { xPx: 0, yPx: 100 },
				bends: []
			}
		];

		const result = evaluateStrongHoles(holes);
		expect(result[0].divergence!).toBeLessThan(0.001);
		expect(result[0].strong).toBe(true);
	});

	test('horizontal hole', () => {
		const holes: StrongHoleInput[] = [
			{
				n: 15,
				badge: { xPx: 50, yPx: 0 }, // On line
				tee: { xPx: 0, yPx: 0 },
				basket: { xPx: 100, yPx: 0 },
				bends: []
			}
		];

		const result = evaluateStrongHoles(holes);
		expect(result[0].divergence!).toBeLessThan(0.001);
		expect(result[0].strong).toBe(true);
	});

	test('no holes input â†’ empty result', () => {
		const result = evaluateStrongHoles([]);
		expect(result).toHaveLength(0);
	});

	test('large-scale hole with small perpendicular offset', () => {
		// A very large hole (2000-unit tee-basket distance) with a 30-unit badge offset â†’ 1.5%
		const holes: StrongHoleInput[] = [
			{
				n: 16,
				badge: { xPx: 1000, yPx: 30 },
				tee: { xPx: 0, yPx: 0 },
				basket: { xPx: 2000, yPx: 0 },
				bends: []
			}
		];

		const result = evaluateStrongHoles(holes);
		expect(result[0].divergence!).toBeLessThanOrEqual(0.016);
		expect(result[0].strong).toBe(true);
	});
});
