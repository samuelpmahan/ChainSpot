import { describe, expect, it } from 'vitest';
import {
	addCorridorPoint,
	addHole,
	addShot,
	clearCorridor,
	nextHoleNumber,
	placeByMode,
	removeHole,
	removeLastCorridorPoint,
	removeLastShot,
	setBasket,
	setTee
} from '../../src/lib/holeAnnotation';
import type { AnnotatedHole } from '../../src/lib/domain/annotatedRound';

function idSequence(prefix: string): () => string {
	let count = 0;
	return () => `${prefix}-${++count}`;
}

describe('nextHoleNumber', () => {
	it('is 1 for an empty list and max-plus-one otherwise', () => {
		expect(nextHoleNumber([])).toBe(1);
		const holes: AnnotatedHole[] = [
			{ id: 'a', number: 1, shots: [] },
			{ id: 'b', number: 3, shots: [] }
		];
		expect(nextHoleNumber(holes)).toBe(4);
	});
});

describe('addHole / removeHole', () => {
	it('appends an empty hole with the next number and does not mutate the input array', () => {
		const original: AnnotatedHole[] = [{ id: 'a', number: 1, shots: [] }];
		const result = addHole(original, idSequence('hole'));

		expect(original).toHaveLength(1);
		expect(result).toHaveLength(2);
		expect(result[1]).toEqual({ id: 'hole-1', number: 2, shots: [] });
	});

	it('removes exactly the hole with the matching id', () => {
		const holes: AnnotatedHole[] = [
			{ id: 'a', number: 1, shots: [] },
			{ id: 'b', number: 2, shots: [] }
		];
		expect(removeHole(holes, 'a')).toEqual([{ id: 'b', number: 2, shots: [] }]);
	});
});

describe('setTee / setBasket', () => {
	it('sets the point on the matching hole only, leaving others untouched', () => {
		const holes: AnnotatedHole[] = [
			{ id: 'a', number: 1, shots: [] },
			{ id: 'b', number: 2, shots: [] }
		];
		const withTee = setTee(holes, 'a', { xPx: 10, yPx: 20 });
		expect(withTee[0].tee).toEqual({ xPx: 10, yPx: 20 });
		expect(withTee[1].tee).toBeUndefined();

		const withBasket = setBasket(withTee, 'a', { xPx: 30, yPx: 40 });
		expect(withBasket[0].basket).toEqual({ xPx: 30, yPx: 40 });
		expect(withBasket[0].tee).toEqual({ xPx: 10, yPx: 20 });
	});

	it('replaces an existing point rather than accumulating', () => {
		const holes: AnnotatedHole[] = [{ id: 'a', number: 1, shots: [], tee: { xPx: 1, yPx: 1 } }];
		const result = setTee(holes, 'a', { xPx: 99, yPx: 99 });
		expect(result[0].tee).toEqual({ xPx: 99, yPx: 99 });
	});
});

describe('addShot / removeLastShot', () => {
	it('appends ordered shots and pops only the last one', () => {
		const createId = idSequence('shot');
		let holes: AnnotatedHole[] = [{ id: 'a', number: 1, shots: [] }];
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
		const holes: AnnotatedHole[] = [{ id: 'a', number: 1, shots: [] }];
		expect(removeLastShot(holes, 'a')[0].shots).toEqual([]);
	});
});

describe('addCorridorPoint / removeLastCorridorPoint / clearCorridor', () => {
	it('builds up a corridor from an absent field and reverts to undefined when emptied', () => {
		let holes: AnnotatedHole[] = [{ id: 'a', number: 1, shots: [] }];
		holes = addCorridorPoint(holes, 'a', { xPx: 1, yPx: 1 });
		holes = addCorridorPoint(holes, 'a', { xPx: 2, yPx: 2 });
		expect(holes[0].corridor).toEqual([
			{ xPx: 1, yPx: 1 },
			{ xPx: 2, yPx: 2 }
		]);

		holes = removeLastCorridorPoint(holes, 'a');
		expect(holes[0].corridor).toEqual([{ xPx: 1, yPx: 1 }]);

		holes = removeLastCorridorPoint(holes, 'a');
		expect(holes[0].corridor).toBeUndefined();
	});

	it('clearCorridor removes a fully-built corridor in one step', () => {
		let holes: AnnotatedHole[] = [{ id: 'a', number: 1, shots: [] }];
		holes = addCorridorPoint(holes, 'a', { xPx: 1, yPx: 1 });
		holes = addCorridorPoint(holes, 'a', { xPx: 2, yPx: 2 });
		holes = clearCorridor(holes, 'a');
		expect(holes[0].corridor).toBeUndefined();
	});
});

describe('placeByMode', () => {
	it('dispatches to the matching operation for each mode', () => {
		const createId = idSequence('shot');
		let holes: AnnotatedHole[] = [{ id: 'a', number: 1, shots: [] }];

		holes = placeByMode(holes, 'a', 'tee', { xPx: 1, yPx: 1 }, createId);
		expect(holes[0].tee).toEqual({ xPx: 1, yPx: 1 });

		holes = placeByMode(holes, 'a', 'basket', { xPx: 2, yPx: 2 }, createId);
		expect(holes[0].basket).toEqual({ xPx: 2, yPx: 2 });

		holes = placeByMode(holes, 'a', 'shot', { xPx: 3, yPx: 3 }, createId);
		expect(holes[0].shots.map((shot) => shot.landing)).toEqual([{ xPx: 3, yPx: 3 }]);

		holes = placeByMode(holes, 'a', 'corridor', { xPx: 4, yPx: 4 }, createId);
		expect(holes[0].corridor).toEqual([{ xPx: 4, yPx: 4 }]);
	});
});
