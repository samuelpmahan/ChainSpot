import { describe, expect, it } from 'vitest';
import {
	addCorridorBend,
	addHole,
	addShot,
	clearBends,
	nextHoleNumber,
	placeByMode,
	removeHole,
	removeLastBend,
	removeLastShot,
	setBasket,
	setCorridorWidth,
	setTee
} from '../../src/lib/holeAnnotation';
import { DEFAULT_CORRIDOR_WIDTH_PX } from '../../src/lib/corridor';
import type { AnnotatedHole } from '../../src/lib/domain/annotatedRound';

function idSequence(prefix: string): () => string {
	let count = 0;
	return () => `${prefix}-${++count}`;
}

function emptyHole(id: string, number: number, overrides: Partial<AnnotatedHole> = {}): AnnotatedHole {
	return { id, number, shots: [], corridorBends: [], corridorWidthPx: DEFAULT_CORRIDOR_WIDTH_PX, ...overrides };
}

describe('nextHoleNumber', () => {
	it('is 1 for an empty list and max-plus-one otherwise', () => {
		expect(nextHoleNumber([])).toBe(1);
		const holes: AnnotatedHole[] = [emptyHole('a', 1), emptyHole('b', 3)];
		expect(nextHoleNumber(holes)).toBe(4);
	});
});

describe('addHole / removeHole', () => {
	it('appends an empty hole with the next number, empty bends, and the default width, without mutating the input array', () => {
		const original: AnnotatedHole[] = [emptyHole('a', 1)];
		const result = addHole(original, idSequence('hole'));

		expect(original).toHaveLength(1);
		expect(result).toHaveLength(2);
		expect(result[1]).toEqual({
			id: 'hole-1',
			number: 2,
			shots: [],
			corridorBends: [],
			corridorWidthPx: DEFAULT_CORRIDOR_WIDTH_PX
		});
	});

	it('removes exactly the hole with the matching id', () => {
		const holes: AnnotatedHole[] = [emptyHole('a', 1), emptyHole('b', 2)];
		expect(removeHole(holes, 'a')).toEqual([emptyHole('b', 2)]);
	});
});

describe('setTee / setBasket', () => {
	it('sets the point on the matching hole only, leaving others untouched', () => {
		const holes: AnnotatedHole[] = [emptyHole('a', 1), emptyHole('b', 2)];
		const withTee = setTee(holes, 'a', { xPx: 10, yPx: 20 });
		expect(withTee[0].tee).toEqual({ xPx: 10, yPx: 20 });
		expect(withTee[1].tee).toBeUndefined();

		const withBasket = setBasket(withTee, 'a', { xPx: 30, yPx: 40 });
		expect(withBasket[0].basket).toEqual({ xPx: 30, yPx: 40 });
		expect(withBasket[0].tee).toEqual({ xPx: 10, yPx: 20 });
	});

	it('replaces an existing point rather than accumulating', () => {
		const holes: AnnotatedHole[] = [emptyHole('a', 1, { tee: { xPx: 1, yPx: 1 } })];
		const result = setTee(holes, 'a', { xPx: 99, yPx: 99 });
		expect(result[0].tee).toEqual({ xPx: 99, yPx: 99 });
	});
});

describe('addShot / removeLastShot', () => {
	it('appends ordered shots and pops only the last one', () => {
		const createId = idSequence('shot');
		let holes: AnnotatedHole[] = [emptyHole('a', 1)];
		holes = addShot(holes, 'a', { xPx: 1, yPx: 1 }, createId);
		holes = addShot(holes, 'a', { xPx: 2, yPx: 2 }, createId);
		expect(holes[0].shots.map((shot) => shot.landing)).toEqual([
			{ xPx: 1, yPx: 1 },
			{ xPx: 2, yPx: 2 }
		]);
		expect(holes[0].shots.map((shot) => shot.id)).toEqual(['shot-1', 'shot-2']);

		holes = removeLastShot(holes, 'a');
		expect(holes[0].shots.map((shot) => shot.landing)).toEqual([{ xPx: 1, yPx: 1 }]);
	});

	it('removing the last shot from an empty list is a no-op, not an error', () => {
		const holes: AnnotatedHole[] = [emptyHole('a', 1)];
		expect(removeLastShot(holes, 'a')[0].shots).toEqual([]);
	});
});

describe('addCorridorBend / removeLastBend / clearBends', () => {
	it('builds up bends from an empty list and pops only the last one', () => {
		let holes: AnnotatedHole[] = [emptyHole('a', 1)];
		holes = addCorridorBend(holes, 'a', { xPx: 1, yPx: 1 });
		holes = addCorridorBend(holes, 'a', { xPx: 2, yPx: 2 });
		expect(holes[0].corridorBends).toEqual([
			{ xPx: 1, yPx: 1 },
			{ xPx: 2, yPx: 2 }
		]);

		holes = removeLastBend(holes, 'a');
		expect(holes[0].corridorBends).toEqual([{ xPx: 1, yPx: 1 }]);

		holes = removeLastBend(holes, 'a');
		expect(holes[0].corridorBends).toEqual([]);
	});

	it('removing the last bend from an empty list keeps an empty straight hole', () => {
		const holes: AnnotatedHole[] = [emptyHole('a', 1)];
		expect(removeLastBend(holes, 'a')[0].corridorBends).toEqual([]);
	});

	it('clearBends removes all bends in one step', () => {
		let holes: AnnotatedHole[] = [emptyHole('a', 1)];
		holes = addCorridorBend(holes, 'a', { xPx: 1, yPx: 1 });
		holes = addCorridorBend(holes, 'a', { xPx: 2, yPx: 2 });
		holes = clearBends(holes, 'a');
		expect(holes[0].corridorBends).toEqual([]);
	});
});

describe('setCorridorWidth', () => {
	it('stores the width on the matching hole only', () => {
		const holes: AnnotatedHole[] = [emptyHole('a', 1), emptyHole('b', 2)];
		const result = setCorridorWidth(holes, 'a', 90);
		expect(result[0].corridorWidthPx).toBe(90);
		expect(result[1].corridorWidthPx).toBe(DEFAULT_CORRIDOR_WIDTH_PX);
	});
});

describe('placeByMode', () => {
	it('dispatches to the matching operation for each mode', () => {
		const createId = idSequence('shot');
		let holes: AnnotatedHole[] = [emptyHole('a', 1)];

		holes = placeByMode(holes, 'a', 'tee', { xPx: 1, yPx: 1 }, createId);
		expect(holes[0].tee).toEqual({ xPx: 1, yPx: 1 });

		holes = placeByMode(holes, 'a', 'basket', { xPx: 2, yPx: 2 }, createId);
		expect(holes[0].basket).toEqual({ xPx: 2, yPx: 2 });

		holes = placeByMode(holes, 'a', 'shot', { xPx: 3, yPx: 3 }, createId);
		expect(holes[0].shots.map((shot) => shot.landing)).toEqual([{ xPx: 3, yPx: 3 }]);

		holes = placeByMode(holes, 'a', 'bend', { xPx: 4, yPx: 4 }, createId);
		expect(holes[0].corridorBends).toEqual([{ xPx: 4, yPx: 4 }]);
	});
});
