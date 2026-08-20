import { describe, expect, it } from 'vitest';
import {
	DEFAULT_CORRIDOR_WIDTH_PX,
	deriveCorridorBand,
	deriveCorridorCenterline
} from '../../src/lib/corridor';
import type { SourcePoint } from '../../src/lib/domain/project';

interface Shape {
	tee?: SourcePoint;
	basket?: SourcePoint;
	corridorBends?: SourcePoint[];
	corridorWidthPx?: number;
}

function shape(overrides: Shape = {}): Shape & { corridorWidthPx: number; corridorBends: SourcePoint[] } {
	return {
		corridorBends: [],
		corridorWidthPx: DEFAULT_CORRIDOR_WIDTH_PX,
		...overrides
	};
}

function allFinite(points: readonly SourcePoint[]): boolean {
	return points.every((point) => Number.isFinite(point.xPx) && Number.isFinite(point.yPx));
}

/** True when no non-adjacent edges of the closed polygon cross. */
function isSimple(points: readonly SourcePoint[]): boolean {
	for (let i = 0; i < points.length; i++) {
		const a = points[i];
		const b = points[(i + 1) % points.length];
		for (let j = i + 1; j < points.length; j++) {
			if (j === i || j === (i + 1) % points.length || (j + 1) % points.length === i) continue;
			const c = points[j];
			const d = points[(j + 1) % points.length];
			if (segmentsCross(a, b, c, d)) return false;
		}
	}
	return true;
}

function orientation(p: SourcePoint, q: SourcePoint, r: SourcePoint): number {
	const value = (q.xPx - p.xPx) * (r.yPx - q.yPx) - (q.yPx - p.yPx) * (r.xPx - q.xPx);
	if (Math.abs(value) < 1e-9) return 0;
	return value > 0 ? 1 : 2;
}

function onSegment(p: SourcePoint, q: SourcePoint, r: SourcePoint): boolean {
	return (
		Math.min(p.xPx, r.xPx) <= q.xPx &&
		q.xPx <= Math.max(p.xPx, r.xPx) &&
		Math.min(p.yPx, r.yPx) <= q.yPx &&
		q.yPx <= Math.max(p.yPx, r.yPx)
	);
}

function segmentsCross(p1: SourcePoint, p2: SourcePoint, q1: SourcePoint, q2: SourcePoint): boolean {
	const o1 = orientation(p1, p2, q1);
	const o2 = orientation(p1, p2, q2);
	const o3 = orientation(q1, q2, p1);
	const o4 = orientation(q1, q2, p2);
	if (o1 !== o2 && o3 !== o4) return true;
	if (o1 === 0 && onSegment(p1, q1, p2)) return true;
	if (o2 === 0 && onSegment(p1, q2, p2)) return true;
	if (o3 === 0 && onSegment(q1, p1, q2)) return true;
	if (o4 === 0 && onSegment(q1, p2, q2)) return true;
	return false;
}

describe('deriveCorridorCenterline', () => {
	it('derives [tee, ...bends, basket] without duplicating endpoints', () => {
		const centerline = deriveCorridorCenterline(
			shape({
				tee: { xPx: 0, yPx: 0 },
				basket: { xPx: 100, yPx: 0 },
				corridorBends: [{ xPx: 50, yPx: 50 }]
			})
		);
		expect(centerline).toEqual([
			{ xPx: 0, yPx: 0 },
			{ xPx: 50, yPx: 50 },
			{ xPx: 100, yPx: 0 }
		]);
	});

	it('filters absent endpoints and keeps zero bends as a two-point line', () => {
		expect(
			deriveCorridorCenterline(shape({ tee: { xPx: 0, yPx: 0 }, basket: { xPx: 100, yPx: 0 } }))
		).toEqual([
			{ xPx: 0, yPx: 0 },
			{ xPx: 100, yPx: 0 }
		]);
		expect(deriveCorridorCenterline(shape({ tee: { xPx: 0, yPx: 0 } }))).toEqual([
			{ xPx: 0, yPx: 0 }
		]);
	});
});

describe('deriveCorridorBand', () => {
	it('derives a sane rectangle for a zero-bend straight hole', () => {
		const band = deriveCorridorBand(
			shape({ tee: { xPx: 0, yPx: 0 }, basket: { xPx: 100, yPx: 0 }, corridorWidthPx: 20 })
		);
		expect(band).not.toBeNull();
		expect(band).toHaveLength(4);
		expect(allFinite(band!)).toBe(true);
		expect(isSimple(band!)).toBe(true);
		const xs = band!.map((point) => point.xPx).sort((a, b) => a - b);
		const ys = band!.map((point) => point.yPx).sort((a, b) => a - b);
		expect(xs[0]).toBeCloseTo(0);
		expect(xs[3]).toBeCloseTo(100);
		expect(ys[0]).toBeCloseTo(-10);
		expect(ys[3]).toBeCloseTo(10);
	});

	it('derives a sane non-self-intersecting band for a one-bend dogleg', () => {
		const band = deriveCorridorBand(
			shape({
				tee: { xPx: 0, yPx: 0 },
				basket: { xPx: 100, yPx: 100 },
				corridorBends: [{ xPx: 100, yPx: 0 }],
				corridorWidthPx: 20
			})
		);
		expect(band).not.toBeNull();
		expect(band).toHaveLength(6); // 2 per segment + 2 miter joints
		expect(allFinite(band!)).toBe(true);
		expect(isSimple(band!)).toBe(true);
	});

	it('derives a finite closed band for multiple bends', () => {
		const band = deriveCorridorBand(
			shape({
				tee: { xPx: 0, yPx: 0 },
				basket: { xPx: 300, yPx: 0 },
				corridorBends: [
					{ xPx: 100, yPx: 0 },
					{ xPx: 100, yPx: 80 },
					{ xPx: 200, yPx: 80 },
					{ xPx: 200, yPx: -40 }
				],
				corridorWidthPx: 20
			})
		);
		expect(band).not.toBeNull();
		expect(band!.length).toBeGreaterThanOrEqual(4);
		expect(allFinite(band!)).toBe(true);
	});

	it('returns null when tee or basket is absent', () => {
		expect(deriveCorridorBand(shape({ basket: { xPx: 100, yPx: 0 } }))).toBeNull();
		expect(deriveCorridorBand(shape({ tee: { xPx: 0, yPx: 0 } }))).toBeNull();
		expect(deriveCorridorBand(shape())).toBeNull();
	});

	it('collapses consecutive duplicate centerline points without producing NaN or Infinity', () => {
		const band = deriveCorridorBand(
			shape({
				tee: { xPx: 0, yPx: 0 },
				basket: { xPx: 100, yPx: 0 },
				corridorBends: [
					{ xPx: 0, yPx: 0 },
					{ xPx: 0, yPx: 0 },
					{ xPx: 100, yPx: 0 }
				],
				corridorWidthPx: 20
			})
		);
		expect(band).not.toBeNull();
		expect(allFinite(band!)).toBe(true);
	});

	it('uses a bevel instead of an enormous spike at a sharp fold', () => {
		const band = deriveCorridorBand(
			shape({
				tee: { xPx: 0, yPx: 0 },
				basket: { xPx: 100, yPx: 0 },
				corridorBends: [{ xPx: 50, yPx: 1 }],
				corridorWidthPx: 20
			})
		);
		expect(band).not.toBeNull();
		expect(allFinite(band!)).toBe(true);
		const maxMagnitude = Math.max(
			...band!.map((point) => Math.max(Math.abs(point.xPx), Math.abs(point.yPx)))
		);
		// Miter capped at MITER_LIMIT * half-width (4 * 10 = 40); no unbounded spike.
		expect(maxMagnitude).toBeLessThanOrEqual(150);
	});

	it('scales the band with the corridor width', () => {
		const narrow = deriveCorridorBand(
			shape({ tee: { xPx: 0, yPx: 0 }, basket: { xPx: 100, yPx: 0 }, corridorWidthPx: 20 })
		)!;
		const wide = deriveCorridorBand(
			shape({ tee: { xPx: 0, yPx: 0 }, basket: { xPx: 100, yPx: 0 }, corridorWidthPx: 40 })
		)!;
		const narrowSpread = Math.max(...narrow.map((point) => point.yPx)) - Math.min(...narrow.map((point) => point.yPx));
		const wideSpread = Math.max(...wide.map((point) => point.yPx)) - Math.min(...wide.map((point) => point.yPx));
		expect(wideSpread).toBeCloseTo(narrowSpread * 2);
	});
});
