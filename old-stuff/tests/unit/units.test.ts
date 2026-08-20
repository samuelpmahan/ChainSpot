import { describe, expect, it } from 'vitest';
import { metersToFeet } from '../../src/lib/units';

describe('metersToFeet', () => {
	it('converts a known value within a tight tolerance', () => {
		expect(metersToFeet(1)).toBeCloseTo(3.280839895, 9);
		expect(metersToFeet(100)).toBeCloseTo(328.0839895, 6);
		expect(metersToFeet(0)).toBe(0);
	});
});
