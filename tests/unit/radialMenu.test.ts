import { describe, expect, it } from 'vitest';
import { clampRingOffset, radialPositions } from '../../src/lib/radialMenu';

describe('radialPositions', () => {
	it('lays out one position per requested count, each a finite point', () => {
		for (const count of [1, 2, 3, 4]) {
			const positions = radialPositions(count);
			expect(positions).toHaveLength(count);
			for (const position of positions) {
				expect(Number.isFinite(position.x)).toBe(true);
				expect(Number.isFinite(position.y)).toBe(true);
			}
		}
	});

	it('places positions at increasing distance from the anchor as the radius grows', () => {
		const tight = radialPositions(4, { radius: 20 });
		const wide = radialPositions(4, { radius: 100 });
		const tightDistance = Math.hypot(tight[0].x, tight[0].y);
		const wideDistance = Math.hypot(wide[0].x, wide[0].y);
		expect(wideDistance).toBeGreaterThan(tightDistance);
		expect(tightDistance).toBeCloseTo(20, 5);
		expect(wideDistance).toBeCloseTo(100, 5);
	});

	it('a single item is placed at 6 o\'clock, opposite the layout\'s 12 o\'clock start', () => {
		const [position] = radialPositions(1, { radius: 50 });
		expect(position.x).toBeCloseTo(0, 5);
		expect(position.y).toBeCloseTo(50, 5);
	});

	it('degenerate counts (zero or negative) fall back to a single position', () => {
		expect(radialPositions(0)).toHaveLength(1);
		expect(radialPositions(-3)).toHaveLength(1);
	});

	it('spaces every position equally around the circle', () => {
		const positions = radialPositions(4, { radius: 10 });
		const distances = positions.map((position, index) => {
			const next = positions[(index + 1) % positions.length];
			return Math.hypot(next.x - position.x, next.y - position.y);
		});
		for (const distance of distances) {
			expect(distance).toBeCloseTo(distances[0], 5);
		}
	});
});

describe('clampRingOffset', () => {
	it('is a no-op when the whole ring already fits inside the bounds', () => {
		const positions = radialPositions(4, { radius: 20 });
		const delta = clampRingOffset(positions, 10, { x: 100, y: 100 }, { width: 400, height: 400 });
		expect(delta).toEqual({ dx: 0, dy: 0 });
	});

	it('pushes the ring rightward and downward when the anchor sits in the top-left corner', () => {
		const positions = radialPositions(4, { radius: 60 });
		const anchor = { x: 5, y: 5 };
		const bounds = { width: 800, height: 600 };
		const delta = clampRingOffset(positions, 44, anchor, bounds);
		expect(delta.dx).toBeGreaterThan(0);
		expect(delta.dy).toBeGreaterThan(0);

		for (const position of positions) {
			const x = anchor.x + position.x + delta.dx;
			const y = anchor.y + position.y + delta.dy;
			expect(x - 22).toBeGreaterThanOrEqual(-1e-9);
			expect(x + 22).toBeLessThanOrEqual(bounds.width + 1e-9);
			expect(y - 22).toBeGreaterThanOrEqual(-1e-9);
			expect(y + 22).toBeLessThanOrEqual(bounds.height + 1e-9);
		}
	});

	it('pulls the ring leftward and upward when the anchor sits in the bottom-right corner', () => {
		const positions = radialPositions(4, { radius: 60 });
		const anchor = { x: 795, y: 595 };
		const bounds = { width: 800, height: 600 };
		const delta = clampRingOffset(positions, 44, anchor, bounds);
		expect(delta.dx).toBeLessThan(0);
		expect(delta.dy).toBeLessThan(0);

		for (const position of positions) {
			const x = anchor.x + position.x + delta.dx;
			const y = anchor.y + position.y + delta.dy;
			expect(x).toBeGreaterThanOrEqual(-1e-9);
			expect(x).toBeLessThanOrEqual(bounds.width + 1e-9);
			expect(y).toBeGreaterThanOrEqual(-1e-9);
			expect(y).toBeLessThanOrEqual(bounds.height + 1e-9);
		}
	});

	it('never moves a ring that already fits along an axis, even when the other axis needs clamping', () => {
		const positions = radialPositions(4, { radius: 60 });
		const anchor = { x: 400, y: 5 };
		const bounds = { width: 800, height: 600 };
		const delta = clampRingOffset(positions, 44, anchor, bounds);
		expect(delta.dx).toBe(0);
		expect(delta.dy).toBeGreaterThan(0);
	});

	it('best-effort centers a ring wider than the available bounds instead of leaving it unclamped', () => {
		const positions = radialPositions(4, { radius: 60 });
		const anchor = { x: 40, y: 40 };
		const bounds = { width: 80, height: 80 };
		const delta = clampRingOffset(positions, 44, anchor, bounds);
		expect(Number.isFinite(delta.dx)).toBe(true);
		expect(Number.isFinite(delta.dy)).toBe(true);
	});

	it('returns a zero delta for an empty ring', () => {
		expect(clampRingOffset([], 44, { x: 0, y: 0 }, { width: 100, height: 100 })).toEqual({
			dx: 0,
			dy: 0
		});
	});
});
