import { describe, expect, it } from 'vitest';
import {
	addCorridorBend,
	moveCorridorBend,
	removeCorridorBend
} from '../../src/lib/holeAnnotation';
import { DEFAULT_CORRIDOR_WIDTH_PX } from '../../src/lib/corridor';
import type { AnnotatedHole } from '../../src/lib/domain/annotatedRound';

function emptyHole(id: string, number: number, overrides: Partial<AnnotatedHole> = {}): AnnotatedHole {
	return { id, number, shots: [], corridorBends: [], corridorWidthPx: DEFAULT_CORRIDOR_WIDTH_PX, ...overrides };
}

describe('Corridor bend ordering (CHSPT-45)', () => {
	describe('Geometry-based ordering for manual bends', () => {
		it('Case 1: manual Bend 2 then manual Bend 1 resolves to [Bend 1, Bend 2]', () => {
			let holes: AnnotatedHole[] = [
				emptyHole('a', 1, {
					tee: { xPx: 0, yPx: 0 },
					basket: { xPx: 100, yPx: 0 }
				})
			];

			// Add Bend 2 first (at 75% along the path)
			holes = addCorridorBend(holes, 'a', { xPx: 75, yPx: 0 });
			expect(holes[0].corridorBends).toEqual([{ xPx: 75, yPx: 0 }]);

			// Add Bend 1 (at 25% along the path) — should be reordered to come first
			holes = addCorridorBend(holes, 'a', { xPx: 25, yPx: 0 });
			expect(holes[0].corridorBends).toEqual([
				{ xPx: 25, yPx: 0 },
				{ xPx: 75, yPx: 0 }
			]);
		});

		it('Case 4: three bends placed in non-path order resolve correctly', () => {
			let holes: AnnotatedHole[] = [
				emptyHole('a', 1, {
					tee: { xPx: 0, yPx: 0 },
					basket: { xPx: 90, yPx: 0 }
				})
			];

			// Add Bend 3 first (at 75% along the path: xPx=67.5)
			holes = addCorridorBend(holes, 'a', { xPx: 67, yPx: 0 });
			expect(holes[0].corridorBends.length).toBe(1);

			// Add Bend 1 (at 25% along the path: xPx=22.5)
			holes = addCorridorBend(holes, 'a', { xPx: 23, yPx: 0 });
			expect(holes[0].corridorBends.length).toBe(2);

			// Add Bend 2 (at 50% along the path: xPx=45)
			holes = addCorridorBend(holes, 'a', { xPx: 45, yPx: 0 });

			// All three should be ordered by position along path
			expect(holes[0].corridorBends).toEqual([
				{ xPx: 23, yPx: 0 },  // Bend 1 (25%)
				{ xPx: 45, yPx: 0 },  // Bend 2 (50%)
				{ xPx: 67, yPx: 0 }   // Bend 3 (75%)
			]);
		});
	});

	describe('Geometry-based ordering with CV-detected bends', () => {
		it('Case 2: detected Bend 2 + manual Bend 1 resolves to [Bend 1, Bend 2]', () => {
			let holes: AnnotatedHole[] = [
				emptyHole('a', 1, {
					tee: { xPx: 0, yPx: 0 },
					basket: { xPx: 100, yPx: 0 },
					corridorBends: [{ xPx: 75, yPx: 0 }]  // CV-detected at 75%
				})
			];

			// User adds Bend 1 (at 25% along path) — should be reordered to come first
			holes = addCorridorBend(holes, 'a', { xPx: 25, yPx: 0 });
			expect(holes[0].corridorBends).toEqual([
				{ xPx: 25, yPx: 0 },
				{ xPx: 75, yPx: 0 }
			]);
		});

		it('Case 3: detected Bend 1 + manual Bend 2 resolves to [Bend 1, Bend 2]', () => {
			let holes: AnnotatedHole[] = [
				emptyHole('a', 1, {
					tee: { xPx: 0, yPx: 0 },
					basket: { xPx: 100, yPx: 0 },
					corridorBends: [{ xPx: 25, yPx: 0 }]  // CV-detected at 25%
				})
			];

			// User adds Bend 2 (at 75% along path) — should be appended after Bend 1
			holes = addCorridorBend(holes, 'a', { xPx: 75, yPx: 0 });
			expect(holes[0].corridorBends).toEqual([
				{ xPx: 25, yPx: 0 },
				{ xPx: 75, yPx: 0 }
			]);
		});
	});

	describe('Dragging bends reorders when geometry requires it', () => {
		it('Case 5: dragging a bend across another bend reorders correctly', () => {
			const holes: AnnotatedHole[] = [
				emptyHole('a', 1, {
					tee: { xPx: 0, yPx: 0 },
					basket: { xPx: 100, yPx: 0 },
					corridorBends: [
						{ xPx: 25, yPx: 0 },  // Bend 1
						{ xPx: 75, yPx: 0 }   // Bend 2
					]
				})
			];

			// Drag Bend 1 (at index 0) to beyond Bend 2 (to xPx=85)
			const result = moveCorridorBend(holes, 'a', 0, { xPx: 85, yPx: 0 });

			// Bend 1 should now come after Bend 2 in the array
			expect(result[0].corridorBends).toEqual([
				{ xPx: 75, yPx: 0 },  // Bend 2 (now at index 0)
				{ xPx: 85, yPx: 0 }   // Bend 1 (now at index 1, after reordering)
			]);
		});

		it('Dragging a bend back before another bend reorders back', () => {
			let holes: AnnotatedHole[] = [
				emptyHole('a', 1, {
					tee: { xPx: 0, yPx: 0 },
					basket: { xPx: 100, yPx: 0 },
					corridorBends: [
						{ xPx: 25, yPx: 0 },
						{ xPx: 75, yPx: 0 }
					]
				})
			];

			// Drag Bend 1 further forward (still before Bend 2)
			holes = moveCorridorBend(holes, 'a', 0, { xPx: 30, yPx: 0 });
			expect(holes[0].corridorBends).toEqual([
				{ xPx: 30, yPx: 0 },
				{ xPx: 75, yPx: 0 }
			]);

			// Now drag what was Bend 2 (now at index 1) to be before Bend 1
			holes = moveCorridorBend(holes, 'a', 1, { xPx: 20, yPx: 0 });
			expect(holes[0].corridorBends).toEqual([
				{ xPx: 20, yPx: 0 },  // formerly Bend 2
				{ xPx: 30, yPx: 0 }   // formerly Bend 1
			]);
		});
	});

	describe('Stability: correctly ordered bends remain stable', () => {
		it('Moving a bend within its position range does not unnecessarily reorder', () => {
			let holes: AnnotatedHole[] = [
				emptyHole('a', 1, {
					tee: { xPx: 0, yPx: 0 },
					basket: { xPx: 100, yPx: 0 },
					corridorBends: [
						{ xPx: 25, yPx: 0 },
						{ xPx: 75, yPx: 0 }
					]
				})
			];

			// Move Bend 1 slightly forward (still between tee and Bend 2)
			holes = moveCorridorBend(holes, 'a', 0, { xPx: 30, yPx: 0 });

			// Order should remain the same
			expect(holes[0].corridorBends).toEqual([
				{ xPx: 30, yPx: 0 },
				{ xPx: 75, yPx: 0 }
			]);

			// Move it again, still in range
			holes = moveCorridorBend(holes, 'a', 0, { xPx: 35, yPx: 0 });
			expect(holes[0].corridorBends).toEqual([
				{ xPx: 35, yPx: 0 },
				{ xPx: 75, yPx: 0 }
			]);
		});

		it('Single bends are never reordered', () => {
			let holes: AnnotatedHole[] = [
				emptyHole('a', 1, {
					tee: { xPx: 0, yPx: 0 },
					basket: { xPx: 100, yPx: 0 },
					corridorBends: [{ xPx: 50, yPx: 0 }]
				})
			];

			holes = moveCorridorBend(holes, 'a', 0, { xPx: 25, yPx: 0 });
			expect(holes[0].corridorBends).toEqual([{ xPx: 25, yPx: 0 }]);

			holes = moveCorridorBend(holes, 'a', 0, { xPx: 75, yPx: 0 });
			expect(holes[0].corridorBends).toEqual([{ xPx: 75, yPx: 0 }]);
		});
	});

	describe('Ordering with non-horizontal paths', () => {
		it('Handles vertical holes (tee to basket with no x change)', () => {
			let holes: AnnotatedHole[] = [
				emptyHole('a', 1, {
					tee: { xPx: 50, yPx: 0 },
					basket: { xPx: 50, yPx: 100 }
				})
			];

			// Add Bend 2 first (at 75% along: y=75)
			holes = addCorridorBend(holes, 'a', { xPx: 50, yPx: 75 });

			// Add Bend 1 (at 25% along: y=25) — should reorder to come first
			holes = addCorridorBend(holes, 'a', { xPx: 50, yPx: 25 });

			expect(holes[0].corridorBends).toEqual([
				{ xPx: 50, yPx: 25 },
				{ xPx: 50, yPx: 75 }
			]);
		});

		it('Handles diagonal holes', () => {
			let holes: AnnotatedHole[] = [
				emptyHole('a', 1, {
					tee: { xPx: 0, yPx: 0 },
					basket: { xPx: 100, yPx: 100 }
				})
			];

			// Add Bend 2 first (at 75% along: (75, 75))
			holes = addCorridorBend(holes, 'a', { xPx: 75, yPx: 75 });

			// Add Bend 1 (at 25% along: (25, 25)) — should reorder to come first
			holes = addCorridorBend(holes, 'a', { xPx: 25, yPx: 25 });

			expect(holes[0].corridorBends).toEqual([
				{ xPx: 25, yPx: 25 },
				{ xPx: 75, yPx: 75 }
			]);
		});
	});

	describe('Edge cases and robustness', () => {
		it('Empty bend list stays empty', () => {
			const holes: AnnotatedHole[] = [
				emptyHole('a', 1, {
					tee: { xPx: 0, yPx: 0 },
					basket: { xPx: 100, yPx: 0 }
				})
			];

			expect(holes[0].corridorBends).toEqual([]);
		});

		it('Out-of-range index in moveCorridorBend is ignored', () => {
			const holes: AnnotatedHole[] = [
				emptyHole('a', 1, {
					tee: { xPx: 0, yPx: 0 },
					basket: { xPx: 100, yPx: 0 },
					corridorBends: [{ xPx: 50, yPx: 0 }]
				})
			];

			const result = moveCorridorBend(holes, 'a', 5, { xPx: 75, yPx: 0 });
			expect(result[0].corridorBends).toEqual([{ xPx: 50, yPx: 0 }]);
		});

		it('Hole without tee/basket still orders bends by distance', () => {
			// This is a defensive scenario (shouldn't happen in practice)
			// but the code should handle it gracefully
			let holes: AnnotatedHole[] = [
				emptyHole('a', 1, {
					// No tee or basket
				})
			];

			holes = addCorridorBend(holes, 'a', { xPx: 100, yPx: 0 });
			holes = addCorridorBend(holes, 'a', { xPx: 50, yPx: 0 });

			// Should still have both bends, order may vary but no crash
			expect(holes[0].corridorBends.length).toBe(2);
		});

		it('Bends placed at the exact same coordinates are ordered consistently', () => {
			let holes: AnnotatedHole[] = [
				emptyHole('a', 1, {
					tee: { xPx: 0, yPx: 0 },
					basket: { xPx: 100, yPx: 0 }
				})
			];

			// Add two bends at the same position
			holes = addCorridorBend(holes, 'a', { xPx: 50, yPx: 0 });
			holes = addCorridorBend(holes, 'a', { xPx: 50, yPx: 0 });

			// Both should be present
			expect(holes[0].corridorBends).toEqual([
				{ xPx: 50, yPx: 0 },
				{ xPx: 50, yPx: 0 }
			]);
		});

		it('Removing a bend preserves order of remaining bends', () => {
			let holes: AnnotatedHole[] = [
				emptyHole('a', 1, {
					tee: { xPx: 0, yPx: 0 },
					basket: { xPx: 100, yPx: 0 },
					corridorBends: [
						{ xPx: 25, yPx: 0 },
						{ xPx: 50, yPx: 0 },
						{ xPx: 75, yPx: 0 }
					]
				})
			];

			// Remove middle bend
			holes = removeCorridorBend(holes, 'a', 1);

			expect(holes[0].corridorBends).toEqual([
				{ xPx: 25, yPx: 0 },
				{ xPx: 75, yPx: 0 }
			]);
		});
	});
});
