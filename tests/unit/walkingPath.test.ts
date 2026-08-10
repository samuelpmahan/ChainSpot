import { describe, expect, it } from 'vitest';
import { addWalkPoint, clearWalkPath, moveWalkPoint, removeWalkPoint } from '../../src/lib/walkingPath';
import type { SourcePoint } from '../../src/lib/domain/project';

const A: SourcePoint = { xPx: 10, yPx: 10 };
const B: SourcePoint = { xPx: 20, yPx: 30 };
const C: SourcePoint = { xPx: 40, yPx: 50 };

describe('walkingPath reducers', () => {
	it('addWalkPoint appends without mutating the input array', () => {
		const original = [A];
		const next = addWalkPoint(original, B);
		expect(next).toEqual([A, B]);
		expect(original).toEqual([A]);
		expect(next).not.toBe(original);
	});

	it('moveWalkPoint replaces only the point at the given index, preserving order', () => {
		const original = [A, B, C];
		const moved: SourcePoint = { xPx: 99, yPx: 99 };
		const next = moveWalkPoint(original, 1, moved);
		expect(next).toEqual([A, moved, C]);
		expect(original).toEqual([A, B, C]);
	});

	it('moveWalkPoint is a no-op copy for an out-of-range index', () => {
		const original = [A, B];
		const next = moveWalkPoint(original, 5, C);
		expect(next).toEqual(original);
		expect(next).not.toBe(original);
	});

	it('removeWalkPoint drops exactly the point at the given index', () => {
		const original = [A, B, C];
		const next = removeWalkPoint(original, 1);
		expect(next).toEqual([A, C]);
		expect(original).toEqual([A, B, C]);
	});

	it('removeWalkPoint is a no-op copy for an out-of-range index', () => {
		const original = [A, B];
		const next = removeWalkPoint(original, -1);
		expect(next).toEqual(original);
		expect(next).not.toBe(original);
	});

	it('clearWalkPath returns an empty array', () => {
		expect(clearWalkPath()).toEqual([]);
	});
});
