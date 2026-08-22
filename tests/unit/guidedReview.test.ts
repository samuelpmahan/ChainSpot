import { describe, expect, test } from 'vitest';
import {
	accept,
	createReview,
	replace,
	currentHole,
	type HoleProposal,
	type Point,
	type ReviewState
} from '$lib/guidedReview';

// Test fixtures
function point(xPx: number, yPx: number): Point {
	return { xPx, yPx };
}

function holeProposal(
	n: number,
	tee: Point | null = null,
	basket: Point | null = null,
	bends: readonly Point[] = []
): HoleProposal {
	return { n, tee, basket, bends };
}

describe('guidedReview', () => {
	test('createReview with empty proposals returns immediately done', () => {
		const state = createReview([]);
		expect(state.holes).toEqual([]);
		expect(state.currentIndex).toBe(0);
		expect(state.done).toBe(true);
	});

	test('createReview sorts proposals by n ascending', () => {
		const proposals = [
			holeProposal(3, point(1, 2)),
			holeProposal(1, point(10, 20)),
			holeProposal(2, point(30, 40))
		];
		const state = createReview(proposals);

		expect(state.holes.length).toBe(3);
		expect(state.holes[0].n).toBe(1);
		expect(state.holes[1].n).toBe(2);
		expect(state.holes[2].n).toBe(3);
		expect(state.currentIndex).toBe(0);
		expect(state.done).toBe(false);
	});

	test('createReview initializes holes with status pending and zero replacements', () => {
		const proposals = [holeProposal(1, point(10, 20), point(50, 60))];
		const state = createReview(proposals);

		const hole = state.holes[0];
		expect(hole.status).toBe('pending');
		expect(hole.replacements).toEqual({ tee: 0, basket: 0, bend: 0 });
	});

	test('createReview copies tee/basket/bends from proposal', () => {
		const tee = point(10, 20);
		const basket = point(50, 60);
		const bends = [point(30, 35), point(40, 45)];
		const proposals = [holeProposal(1, tee, basket, bends)];
		const state = createReview(proposals);

		const hole = state.holes[0];
		expect(hole.tee).toBe(tee);
		expect(hole.basket).toBe(basket);
		expect(hole.bends).toBe(bends);
	});

	test('accept on unknown holeN returns same state reference', () => {
		const state = createReview([holeProposal(1, point(10, 20))]);
		const result = accept(state, 999);

		expect(result).toBe(state);
	});

	test('accept on already accepted hole returns same state reference', () => {
		const state = createReview([holeProposal(1, point(10, 20))]);
		const accepted = accept(state, 1);
		const result = accept(accepted, 1);

		expect(result).toBe(accepted);
	});

	test('accept changes target hole to accepted and preserves object references for others', () => {
		const state = createReview([
			holeProposal(1, point(10, 20)),
			holeProposal(2, point(30, 40)),
			holeProposal(3, point(50, 60))
		]);

		const result = accept(state, 1);

		expect(result.holes[0].status).toBe('accepted');
		expect(result.holes[1]).toBe(state.holes[1]); // Object reference preserved
		expect(result.holes[2]).toBe(state.holes[2]); // Object reference preserved
	});

	test('accept advances currentIndex to next pending hole', () => {
		const state = createReview([
			holeProposal(1, point(10, 20)),
			holeProposal(2, point(30, 40)),
			holeProposal(3, point(50, 60))
		]);

		const step1 = accept(state, 1);
		expect(step1.currentIndex).toBe(1);
		expect(step1.done).toBe(false);

		const step2 = accept(step1, 2);
		expect(step2.currentIndex).toBe(2);
		expect(step2.done).toBe(false);

		const step3 = accept(step2, 3);
		expect(step3.currentIndex).toBe(3);
		expect(step3.done).toBe(true);
	});

	test('accept all holes in order drives done:true', () => {
		const state = createReview([
			holeProposal(1, point(10, 20)),
			holeProposal(2, point(30, 40)),
			holeProposal(3, point(50, 60))
		]);

		const step1 = accept(state, 1);
		const step2 = accept(step1, 2);
		const step3 = accept(step2, 3);

		expect(step3.currentIndex).toBe(3);
		expect(step3.holes.length).toBe(3);
		expect(step3.done).toBe(true);
	});

	test('replace on unknown holeN returns state unchanged', () => {
		const state = createReview([holeProposal(1, point(10, 20))]);
		const result = replace(state, 999, 'tee', point(100, 100));

		expect(result).toBe(state);
	});

	test('replace on tee updates tee and increments replacements.tee', () => {
		const state = createReview([holeProposal(1, point(10, 20), point(50, 60))]);
		const newPoint = point(100, 100);

		const result = replace(state, 1, 'tee', newPoint);

		expect(result.holes[0].tee).toBe(newPoint);
		expect(result.holes[0].replacements.tee).toBe(1);
		expect(result.holes[0].status).toBe('accepted');
	});

	test('replace on basket updates basket and increments replacements.basket', () => {
		const state = createReview([holeProposal(1, point(10, 20), point(50, 60))]);
		const newPoint = point(100, 100);

		const result = replace(state, 1, 'basket', newPoint);

		expect(result.holes[0].basket).toBe(newPoint);
		expect(result.holes[0].replacements.basket).toBe(1);
		expect(result.holes[0].status).toBe('accepted');
	});

	test('replace on bend updates bends to single-element array and increments replacements.bend', () => {
		const state = createReview([holeProposal(1, point(10, 20), point(50, 60), [point(30, 35)])]);
		const newPoint = point(100, 100);

		const result = replace(state, 1, 'bend', newPoint);

		expect(result.holes[0].bends).toEqual([newPoint]);
		expect(result.holes[0].replacements.bend).toBe(1);
		expect(result.holes[0].status).toBe('accepted');
	});

	test('replace accumulates replacement counters', () => {
		const state = createReview([holeProposal(1, point(10, 20), point(50, 60))]);

		const step1 = replace(state, 1, 'tee', point(100, 100));
		expect(step1.holes[0].replacements.tee).toBe(1);

		const step2 = replace(step1, 1, 'tee', point(200, 200));
		expect(step2.holes[0].replacements.tee).toBe(2);
	});

	test('replace sets status to accepted and advances queue if hole is current', () => {
		const state = createReview([
			holeProposal(1, point(10, 20)),
			holeProposal(2, point(30, 40)),
			holeProposal(3, point(50, 60))
		]);

		const result = replace(state, 1, 'tee', point(100, 100));

		expect(result.holes[0].status).toBe('accepted');
		expect(result.currentIndex).toBe(1);
		expect(result.done).toBe(false);
	});

	test('currentHole returns null when state is done', () => {
		const state = createReview([]);
		const hole = currentHole(state);

		expect(hole).toBe(null);
	});

	test('currentHole returns current pending hole', () => {
		const state = createReview([
			holeProposal(1, point(10, 20)),
			holeProposal(2, point(30, 40)),
			holeProposal(3, point(50, 60))
		]);

		const hole1 = currentHole(state);
		expect(hole1?.n).toBe(1);

		const step1 = accept(state, 1);
		const hole2 = currentHole(step1);
		expect(hole2?.n).toBe(2);
	});

	test('end-to-end: full review with mixed accept and replace', () => {
		// Build a 5-hole fixture
		const proposals = [
			holeProposal(1, point(45, 250), point(95, 95), [point(60, 170)]),
			holeProposal(2, point(115, 85), point(155, 235), [point(135, 160)]),
			holeProposal(3, point(560, 35), point(330, 95), [point(262, 180)]), // flawed tee
			holeProposal(4, point(355, 65), point(470, 155), [point(432, 82)]),
			holeProposal(5, point(430, 250), point(560, 165), [point(350, 265)])  // flawed bend
		];

		let state = createReview(proposals);

		// accept(1)
		state = accept(state, 1);
		expect(state.holes[0].status).toBe('accepted');
		expect(state.currentIndex).toBe(1);

		// accept(2)
		state = accept(state, 2);
		expect(state.holes[1].status).toBe('accepted');
		expect(state.currentIndex).toBe(2);

		// replace(3, 'tee', p) — hole 3's tee was wrong, replace it
		state = replace(state, 3, 'tee', point(225, 235));
		expect(state.holes[2].tee).toEqual(point(225, 235));
		expect(state.holes[2].status).toBe('accepted');
		expect(state.holes[2].replacements.tee).toBe(1);
		expect(state.currentIndex).toBe(3);

		// accept(4)
		state = accept(state, 4);
		expect(state.holes[3].status).toBe('accepted');
		expect(state.currentIndex).toBe(4);

		// replace(5, 'bend', p) — hole 5's bend was wrong, replace it
		state = replace(state, 5, 'bend', point(492, 232));
		expect(state.holes[4].bends).toEqual([point(492, 232)]);
		expect(state.holes[4].status).toBe('accepted');
		expect(state.holes[4].replacements.bend).toBe(1);
		expect(state.currentIndex).toBe(5);

		// Verify final state is done with all holes accepted
		expect(state.done).toBe(true);
		for (const hole of state.holes) {
			expect(hole.status).toBe('accepted');
		}
	});
});
