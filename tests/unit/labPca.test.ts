import { describe, expect, test } from 'vitest';
import { factorMatrix } from '../../scripts/chainspot-lab/experiments/pca';
import { rotateRadialValues } from '../../scripts/chainspot-lab/experiments/radialRender';

describe('LAB sample-space factorization', () => {
	test('an uncentered rank-one matrix puts all energy in one shared factor with deterministic sign', () => {
		const result = factorMatrix([
			[1, 2, 3],
			[2, 4, 6],
			[3, 6, 9]
		], { center: false, maxComponents: 3 });
		expect(result.components).toHaveLength(1);
		expect(result.components[0].energyFraction).toBeCloseTo(1, 12);
		expect(result.components[0].scores.every((score) => score > 0)).toBe(true);
		expect(result.components[0].values[2]).toBeGreaterThan(result.components[0].values[1]);
	});

	test('centered PCA removes a shared offset rather than mislabeling it variation', () => {
		const result = factorMatrix([
			[10, 20, 30],
			[11, 20, 29],
			[9, 20, 31]
		], { center: true, maxComponents: 3 });
		expect(result.mean).toEqual([10, 20, 30]);
		expect(result.components).toHaveLength(1);
		expect(result.components[0].energyFraction).toBeCloseTo(1, 12);
		expect(Math.abs(result.components[0].values[1])).toBeLessThan(1e-12);
	});

	test('rejects ragged or non-finite evidence instead of silently repairing it', () => {
		expect(() => factorMatrix([[1, 2], [3]], { center: false })).toThrow(/columns/);
		expect(() => factorMatrix([[1, Number.NaN]], { center: false })).toThrow(/not finite/);
	});
});

describe('TrueNorth radial rotation', () => {
	test('moves the supplied truth bearing to visual bin zero', () => {
		expect(rotateRadialValues([0, 1, 2, 3], 90)).toEqual([1, 2, 3, 0]);
	});

	test('preserves UNKNOWN rather than interpolating through it', () => {
		expect(rotateRadialValues([0, null, 2, 3], 90)).toEqual([null, 2, 3, 0]);
	});
});
