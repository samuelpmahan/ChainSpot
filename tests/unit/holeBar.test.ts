import { describe, expect, it } from 'vitest';
import { DEFAULT_CORRIDOR_WIDTH_PX } from '../../src/lib/corridor';
import { getHoleBarIndicators, getHoleBarLabel } from '../../src/lib/holeBar';
import type { AnnotatedHole } from '../../src/lib/domain/annotatedRound';

function hole(overrides: Partial<AnnotatedHole> = {}): AnnotatedHole {
	return {
		id: 'hole-1',
		number: 1,
		shots: [],
		corridorBends: [],
		corridorWidthPx: DEFAULT_CORRIDOR_WIDTH_PX,
		...overrides
	};
}

describe('hole bar state', () => {
	it('derives the five compact indicators from persisted hole data', () => {
		const indicators = getHoleBarIndicators(
			hole({
				tee: { xPx: 1, yPx: 2 },
				basket: { xPx: 3, yPx: 4 },
				corridorBends: [{ xPx: 5, yPx: 6 }, { xPx: 7, yPx: 8 }],
				shots: [
					{ id: 'shot-1', landing: { xPx: 9, yPx: 10 } },
					{ id: 'shot-2', landing: { xPx: 11, yPx: 12 } }
				]
			})
		);

		expect(indicators).toEqual({ tee: true, basket: true, number: true, bends: 2, throws: 2 });
	});

	it('produces an accessible label that exposes selection and missing/present state', () => {
		expect(getHoleBarLabel(hole(), false)).toBe('Hole 1: tee missing, basket missing, number present, 0 bends, 0 throws');
		expect(getHoleBarLabel(hole({ tee: { xPx: 1, yPx: 2 }}), true)).toContain('Hole 1, selected: tee present');
	});
});
