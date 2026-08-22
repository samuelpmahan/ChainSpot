import { describe, expect, test } from 'vitest';
import { detectCourse } from '$lib/courseDetect';
import type { SeedBadge } from '$lib/courseDetect';

describe('detectCourse', () => {
	test('empty badges yields empty proposals', () => {
		expect(detectCourse([])).toEqual([]);
	});

	test('badges given out of order are sorted ascending by n', () => {
		const badges: SeedBadge[] = [
			{ n: 3, xPx: 100, yPx: 100 },
			{ n: 1, xPx: 10, yPx: 10 },
			{ n: 2, xPx: 50, yPx: 50 },
		];

		const proposals = detectCourse(badges);
		expect(proposals.map((p) => p.n)).toEqual([1, 2, 3]);
	});

	test('two sightings of the same n merge into one proposal at their arithmetic mean', () => {
		const badges: SeedBadge[] = [
			{ n: 3, xPx: 10, yPx: 10 },
			{ n: 3, xPx: 12, yPx: 12 },
		];

		const proposals = detectCourse(badges);
		expect(proposals).toHaveLength(1);
		expect(proposals[0].n).toBe(3);
		expect(proposals[0].tee).toBeNull();
		expect(proposals[0].basket).toBeNull();
		expect(proposals[0].bends).toEqual([]);
	});

	test('every emitted proposal has tee:null, basket:null, bends:[], and all confidence fields 0', () => {
		const badges: SeedBadge[] = [
			{ n: 1, xPx: 5, yPx: 7 },
			{ n: 2, xPx: 15, yPx: 20 },
		];

		const proposals = detectCourse(badges);
		for (const proposal of proposals) {
			expect(proposal.tee).toBeNull();
			expect(proposal.basket).toBeNull();
			expect(proposal.bends).toEqual([]);
		}
	});

	test('badges with n:0 or n<0 are silently dropped', () => {
		const badges: SeedBadge[] = [
			{ n: 0, xPx: 10, yPx: 10 },
			{ n: -1, xPx: 20, yPx: 20 },
			{ n: 1, xPx: 30, yPx: 30 },
		];

		const proposals = detectCourse(badges);
		expect(proposals).toHaveLength(1);
		expect(proposals[0].n).toBe(1);
	});

	test('badges with non-finite coordinates are silently dropped', () => {
		const badges: SeedBadge[] = [
			{ n: 1, xPx: NaN, yPx: 10 },
			{ n: 2, xPx: 10, yPx: Infinity },
			{ n: 3, xPx: 10, yPx: 10 },
		];

		const proposals = detectCourse(badges);
		expect(proposals).toHaveLength(1);
		expect(proposals[0].n).toBe(3);
	});
});
