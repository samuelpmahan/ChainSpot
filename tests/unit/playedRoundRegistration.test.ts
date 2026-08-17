import { describe, expect, it } from 'vitest';
import { composedProofPoints, composePlayedToTarget } from '../../src/lib/playedRoundRegistration';
import type { ControlPointPair } from '../../src/lib/domain/project';
import type { SerializableTransform } from '../../src/lib/alignment/types';

const translation = (x: number, y: number): SerializableTransform => ({
	model: 'similarity',
	coefficients: [1, 0, 0, 1, x, y],
	isInvertible: true,
	determinant: 1,
	orientation: 1,
	majorAxisScale: 1,
	minorAxisScale: 1,
	anisotropy: 1,
	shear: 0
});

function pair(id: string, enabled = true): ControlPointPair {
	return {
		id,
		ordinal: Number(id.slice(1)),
		label: null,
		enabled,
		source: { imageId: 'played', xPx: 10, yPx: 20 },
		target: { imageId: 'clean', xPx: 30, yPx: 40 },
		createdAt: '2026-08-17T00:00:00.000Z',
		updatedAt: '2026-08-17T00:00:00.000Z'
	};
}

describe('played-round registration composition', () => {
	it('maps played pixels through clean-course space before target space', () => {
		expect(composePlayedToTarget({ xPx: 10, yPx: 20 }, translation(5, 7), translation(100, 200))).toEqual({
			xPx: 115,
			yPx: 227
		});
	});

	it('emits only enabled landmark proof points and requires both transforms', () => {
		expect(composedProofPoints([pair('p1'), pair('p2', false)], translation(5, 7), translation(100, 200))).toEqual([
			{ id: 'p1', xPx: 115, yPx: 227 }
		]);
		expect(composedProofPoints([pair('p1')], translation(5, 7), null)).toEqual([]);
	});
});
