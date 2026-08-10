import { describe, expect, it } from 'vitest';
import {
	addCorridorBend,
	addHole,
	addHoleBeyondStandardCourse,
	addShot,
	assignCandidateToHole,
	clearBends,
	moveBasket,
	moveCorridorBend,
	moveShot,
	moveTee,
	nextHoleNumber,
	placeByMode,
	removeBasket,
	removeCorridorBend,
	removeHole,
	removeLastBend,
	removeLastShot,
	removeShot,
	removeTee,
	setAllCorridorWidths,
	setBasket,
	setCorridorWidth,
	setTee
} from '../../src/lib/holeAnnotation';
import { acceptCandidate } from '../../src/lib/cv/types';
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
	it('is the lowest missing number from 1 through 18', () => {
		expect(nextHoleNumber([])).toBe(1);
		const holes: AnnotatedHole[] = [emptyHole('a', 1), emptyHole('b', 3)];
		expect(nextHoleNumber(holes)).toBe(2);
		expect(nextHoleNumber(Array.from({ length: 18 }, (_, index) => emptyHole(`${index}`, index + 1)))).toBeNull();
	});
});

describe('addHole / removeHole', () => {
	it('inserts the lowest missing hole in numeric order without mutating or changing existing records', () => {
		const original: AnnotatedHole[] = [
			emptyHole('a', 1, { tee: { xPx: 10, yPx: 20 } }),
			emptyHole('c', 3, { shots: [{ id: 'shot-1', landing: { xPx: 1, yPx: 2 } }] })
		];
		const result = addHole(original, idSequence('hole'));

		expect(original.map((hole) => hole.number)).toEqual([1, 3]);
		expect(result.map((hole) => hole.number)).toEqual([1, 2, 3]);
		expect(result[0]).toBe(original[0]);
		expect(result[2]).toBe(original[1]);
		expect(result[1]).toEqual({
			id: 'hole-1',
			number: 2,
			shots: [],
			corridorBends: [],
			corridorWidthPx: DEFAULT_CORRIDOR_WIDTH_PX
		});
	});

	it('fills missing hole numbers in ascending order and stops after hole 18', () => {
		let holes: AnnotatedHole[] = [2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 14, 15, 17].map((number) =>
			emptyHole(`hole-${number}`, number)
		);
		const createId = idSequence('added');

		const addedNumbers: number[] = [];
		for (let index = 0; index < 5; index += 1) {
			const expectedNumber = nextHoleNumber(holes);
			holes = addHole(holes, createId);
			addedNumbers.push(expectedNumber!);
		}

		expect(addedNumbers).toEqual([1, 5, 13, 16, 18]);
		expect(addHole(holes, createId)).toHaveLength(18);
	});

	it('adds post-18 holes after the current maximum in numeric order', () => {
		const holes: AnnotatedHole[] = [emptyHole('a', 1), emptyHole('b', 19), emptyHole('c', 21)];
		const result = addHoleBeyondStandardCourse(holes, idSequence('extra'));

		expect(result.map((hole) => hole.number)).toEqual([1, 19, 21, 22]);
		expect(result[0]).toBe(holes[0]);
		expect(result[1]).toBe(holes[1]);
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

describe('moveTee / moveBasket', () => {
	it('moves only the existing endpoint on the matching hole', () => {
		const holes: AnnotatedHole[] = [
			emptyHole('a', 1, { tee: { xPx: 1, yPx: 2 }, basket: { xPx: 3, yPx: 4 } }),
			emptyHole('b', 2, { tee: { xPx: 5, yPx: 6 } })
		];

		const movedTee = moveTee(holes, 'a', { xPx: 11, yPx: 12 });
		const movedBasket = moveBasket(movedTee, 'a', { xPx: 13, yPx: 14 });

		expect(movedBasket[0].tee).toEqual({ xPx: 11, yPx: 12 });
		expect(movedBasket[0].basket).toEqual({ xPx: 13, yPx: 14 });
		expect(movedBasket[1]).toEqual(holes[1]);
	});
});

describe('removeTee / removeBasket', () => {
	it('clears only the targeted point on the matching hole', () => {
		const holes: AnnotatedHole[] = [
			emptyHole('a', 1, { tee: { xPx: 1, yPx: 2 }, basket: { xPx: 3, yPx: 4 } }),
			emptyHole('b', 2, { tee: { xPx: 5, yPx: 6 }, basket: { xPx: 7, yPx: 8 } })
		];

		const teeCleared = removeTee(holes, 'a');
		expect(teeCleared[0].tee).toBeUndefined();
		expect(teeCleared[0].basket).toEqual({ xPx: 3, yPx: 4 });
		expect(teeCleared[1]).toEqual(holes[1]);

		const basketCleared = removeBasket(teeCleared, 'a');
		expect(basketCleared[0].basket).toBeUndefined();
	});

	it('clearing an already-absent point is a no-op, not an error', () => {
		const holes: AnnotatedHole[] = [emptyHole('a', 1)];
		expect(removeTee(holes, 'a')[0].tee).toBeUndefined();
		expect(removeBasket(holes, 'a')[0].basket).toBeUndefined();
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

describe('removeShot', () => {
	it('removes exactly the shot with the matching id, regardless of position', () => {
		const holes: AnnotatedHole[] = [
			emptyHole('a', 1, {
				shots: [
					{ id: 'shot-1', landing: { xPx: 1, yPx: 2 } },
					{ id: 'shot-2', landing: { xPx: 3, yPx: 4 } },
					{ id: 'shot-3', landing: { xPx: 5, yPx: 6 } }
				]
			})
		];

		const result = removeShot(holes, 'a', 'shot-2');

		expect(result[0].shots.map((shot) => shot.id)).toEqual(['shot-1', 'shot-3']);
	});

	it('removing an unknown shot id is a no-op, not an error', () => {
		const holes: AnnotatedHole[] = [
			emptyHole('a', 1, { shots: [{ id: 'shot-1', landing: { xPx: 1, yPx: 2 } }] })
		];
		expect(removeShot(holes, 'a', 'missing')[0].shots).toEqual(holes[0].shots);
	});
});

describe('moveShot', () => {
	it('changes only the selected landing and preserves shot ids and order', () => {
		const holes: AnnotatedHole[] = [
			emptyHole('a', 1, {
				shots: [
					{ id: 'shot-1', landing: { xPx: 1, yPx: 2 } },
					{ id: 'shot-2', landing: { xPx: 3, yPx: 4 } }
				]
			})
		];

		const result = moveShot(holes, 'a', 'shot-2', { xPx: 30, yPx: 40 });

		expect(result[0].shots).toEqual([
			{ id: 'shot-1', landing: { xPx: 1, yPx: 2 } },
			{ id: 'shot-2', landing: { xPx: 30, yPx: 40 } }
		]);
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

describe('removeCorridorBend', () => {
	it('removes exactly the bend at the given index, preserving order', () => {
		const holes: AnnotatedHole[] = [
			emptyHole('a', 1, {
				corridorBends: [
					{ xPx: 1, yPx: 2 },
					{ xPx: 3, yPx: 4 },
					{ xPx: 5, yPx: 6 }
				]
			})
		];

		const result = removeCorridorBend(holes, 'a', 1);

		expect(result[0].corridorBends).toEqual([
			{ xPx: 1, yPx: 2 },
			{ xPx: 5, yPx: 6 }
		]);
	});

	it('an out-of-range index is a no-op, not an error', () => {
		const holes: AnnotatedHole[] = [emptyHole('a', 1, { corridorBends: [{ xPx: 1, yPx: 2 }] })];
		expect(removeCorridorBend(holes, 'a', 5)[0].corridorBends).toEqual(holes[0].corridorBends);
		expect(removeCorridorBend(holes, 'a', -1)[0].corridorBends).toEqual(holes[0].corridorBends);
	});
});

describe('moveCorridorBend', () => {
	it('changes only the selected index and preserves bend order', () => {
		const holes: AnnotatedHole[] = [
			emptyHole('a', 1, {
				corridorBends: [
					{ xPx: 1, yPx: 2 },
					{ xPx: 3, yPx: 4 },
					{ xPx: 5, yPx: 6 }
				]
			})
		];

		const result = moveCorridorBend(holes, 'a', 1, { xPx: 30, yPx: 40 });

		expect(result[0].corridorBends).toEqual([
			{ xPx: 1, yPx: 2 },
			{ xPx: 30, yPx: 40 },
			{ xPx: 5, yPx: 6 }
		]);
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

describe('setAllCorridorWidths', () => {
	it('applies the same width to every hole, regardless of their prior widths', () => {
		const holes: AnnotatedHole[] = [
			emptyHole('a', 1, { corridorWidthPx: 40 }),
			emptyHole('b', 2, { corridorWidthPx: 90 }),
			emptyHole('c', 3)
		];
		const result = setAllCorridorWidths(holes, 75);
		expect(result.map((hole) => hole.corridorWidthPx)).toEqual([75, 75, 75]);
	});

	it('preserves every other field on every hole, and does not mutate the input', () => {
		const holes: AnnotatedHole[] = [
			emptyHole('a', 1, {
				tee: { xPx: 10, yPx: 20 },
				basket: { xPx: 30, yPx: 40 },
				shots: [{ id: 'shot-1', landing: { xPx: 1, yPx: 2 } }],
				corridorBends: [{ xPx: 5, yPx: 6 }]
			}),
			emptyHole('b', 2)
		];
		const result = setAllCorridorWidths(holes, 100);

		expect(result[0]).toEqual({ ...holes[0], corridorWidthPx: 100 });
		expect(result[1]).toEqual({ ...holes[1], corridorWidthPx: 100 });
		expect(holes[0].corridorWidthPx).toBe(DEFAULT_CORRIDOR_WIDTH_PX);
		expect(holes[1].corridorWidthPx).toBe(DEFAULT_CORRIDOR_WIDTH_PX);
	});

	it('is a no-op-shaped map over an empty array', () => {
		expect(setAllCorridorWidths([], 50)).toEqual([]);
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

/**
 * Annotate Round's click-to-assign interaction (Detected CV UX, PART C): a
 * single primitive behind instant-assign, replace, and move. Coordinates
 * only ever cross from a CV candidate through `acceptCandidate` first,
 * mirroring how the page itself always calls it before reaching this
 * function — never a raw `{...candidate}` spread.
 */
describe('assignCandidateToHole', () => {
	it('assigns onto a hole with no existing point of that kind (instant-assign case), leaving other holes untouched', () => {
		const holes: AnnotatedHole[] = [emptyHole('a', 1), emptyHole('b', 2, { tee: { xPx: 9, yPx: 9 } })];
		const result = assignCandidateToHole(holes, 'a', 'basket', { xPx: 40, yPx: 50 });

		expect(result[0]).toEqual({ ...holes[0], basket: { xPx: 40, yPx: 50 } });
		expect(result[1]).toBe(holes[1]);
		expect(holes[0].basket).toBeUndefined(); // input never mutated
	});

	it('replaces an existing point on the target hole in place (replace case)', () => {
		const holes: AnnotatedHole[] = [emptyHole('a', 1, { tee: { xPx: 1, yPx: 1 } })];
		const result = assignCandidateToHole(holes, 'a', 'tee', { xPx: 99, yPx: 99 });

		expect(result[0].tee).toEqual({ xPx: 99, yPx: 99 });
		expect(holes[0].tee).toEqual({ xPx: 1, yPx: 1 }); // input never mutated
	});

	it('moves a point from whichever OTHER hole currently holds those exact coordinates onto the target (move case)', () => {
		const holes: AnnotatedHole[] = [
			emptyHole('a', 1),
			emptyHole('b', 2, { basket: { xPx: 5, yPx: 6 } })
		];
		const result = assignCandidateToHole(holes, 'a', 'basket', { xPx: 5, yPx: 6 });

		expect(result.find((hole) => hole.id === 'a')?.basket).toEqual({ xPx: 5, yPx: 6 });
		expect(result.find((hole) => hole.id === 'b')?.basket).toBeUndefined();
		// The source hole's OTHER fields are untouched by the move.
		expect(result.find((hole) => hole.id === 'b')?.number).toBe(2);
	});

	it('combines replace and move in one call: the target is overwritten AND the point is cleared from wherever else it lived', () => {
		const holes: AnnotatedHole[] = [
			emptyHole('a', 1, { tee: { xPx: 1, yPx: 1 } }),
			emptyHole('b', 2, { tee: { xPx: 7, yPx: 8 } })
		];
		const result = assignCandidateToHole(holes, 'a', 'tee', { xPx: 7, yPx: 8 });

		expect(result.find((hole) => hole.id === 'a')?.tee).toEqual({ xPx: 7, yPx: 8 });
		expect(result.find((hole) => hole.id === 'b')?.tee).toBeUndefined();
	});

	it('only clears an OTHER hole holding the exact same coordinates — a different point of the same kind is left alone', () => {
		const holes: AnnotatedHole[] = [
			emptyHole('a', 1),
			emptyHole('b', 2, { basket: { xPx: 100, yPx: 200 } })
		];
		const result = assignCandidateToHole(holes, 'a', 'basket', { xPx: 5, yPx: 6 });

		expect(result.find((hole) => hole.id === 'a')?.basket).toEqual({ xPx: 5, yPx: 6 });
		expect(result.find((hole) => hole.id === 'b')?.basket).toEqual({ xPx: 100, yPx: 200 });
	});

	it('carries only {xPx, yPx} from a CV candidate onto the hole — acceptCandidate strips score before this ever runs', () => {
		const candidate = { xPx: 12, yPx: 34, score: 0.91, widthPx: 5, heightPx: 5 };
		const holes: AnnotatedHole[] = [emptyHole('a', 1)];
		const result = assignCandidateToHole(holes, 'a', 'basket', acceptCandidate(candidate));

		expect(result[0].basket).toEqual({ xPx: 12, yPx: 34 });
		expect(Object.keys(result[0].basket!)).toEqual(['xPx', 'yPx']);
	});

	it('is undo-safe: applying then reversing the exact sequence of moves restores the original state exactly, through the same reassignment path every other holeAnnotation operation uses', () => {
		// Annotate Round keeps no separate undo stack for `holes` today — this
		// reducer is called the same way `moveTee`/`moveBasket`/`removeTee`/
		// `removeBasket` already are (`holes = fn(holes, ...)`), so it is
		// automatically covered by any future undo/redo work exactly as those
		// are. Reversibility through the pure reducers themselves is the
		// strongest property testable without that stack existing yet.
		const original: AnnotatedHole[] = [
			emptyHole('a', 1, { basket: { xPx: 5, yPx: 6 } }),
			emptyHole('b', 2)
		];

		// "Move": basket goes from hole a to hole b.
		const moved = assignCandidateToHole(original, 'b', 'basket', { xPx: 5, yPx: 6 });
		expect(moved.find((hole) => hole.id === 'a')?.basket).toBeUndefined();
		expect(moved.find((hole) => hole.id === 'b')?.basket).toEqual({ xPx: 5, yPx: 6 });

		// Undo: move it back from hole b to hole a.
		const restored = assignCandidateToHole(moved, 'a', 'basket', { xPx: 5, yPx: 6 });
		expect(restored).toEqual(original);
	});
});
