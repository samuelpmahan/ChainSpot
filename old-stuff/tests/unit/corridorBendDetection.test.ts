import { describe, expect, it } from 'vitest';
import {
	applyDetectedCorridorBends,
	buildTraversabilityMask,
	detectCorridorBends,
	simplifyPolylineRDP,
	traceShortestOpenPath
} from '../../src/lib/autoAnnotation/corridorBendDetection';
import type { CorridorBendRaster } from '../../src/lib/autoAnnotation/corridorBendDetection';
import { DEFAULT_CORRIDOR_WIDTH_PX } from '../../src/lib/corridor';
import type { AnnotatedHole } from '../../src/lib/domain/annotatedRound';
import type { SourcePoint } from '../../src/lib/domain/project';

function emptyHole(id: string, number: number, overrides: Partial<AnnotatedHole> = {}): AnnotatedHole {
	return { id, number, shots: [], corridorBends: [], corridorWidthPx: DEFAULT_CORRIDOR_WIDTH_PX, ...overrides };
}

describe('simplifyPolylineRDP', () => {
	it('collapses a straight line with an on-line midpoint to just its endpoints', () => {
		const points: SourcePoint[] = [
			{ xPx: 0, yPx: 0 },
			{ xPx: 50, yPx: 50 },
			{ xPx: 100, yPx: 100 }
		];
		expect(simplifyPolylineRDP(points, 10)).toEqual([
			{ xPx: 0, yPx: 0 },
			{ xPx: 100, yPx: 100 }
		]);
	});

	it('keeps a genuine corner that deviates beyond epsilon', () => {
		const points: SourcePoint[] = [
			{ xPx: 0, yPx: 0 },
			{ xPx: 50, yPx: 40 },
			{ xPx: 100, yPx: 0 }
		];
		// Midpoint sits 40px off the direct line — well beyond a 10px epsilon.
		expect(simplifyPolylineRDP(points, 10)).toEqual(points);
	});

	it('drops a wobble within epsilon', () => {
		const points: SourcePoint[] = [
			{ xPx: 0, yPx: 0 },
			{ xPx: 50, yPx: 3 },
			{ xPx: 100, yPx: 0 }
		];
		expect(simplifyPolylineRDP(points, 10)).toEqual([
			{ xPx: 0, yPx: 0 },
			{ xPx: 100, yPx: 0 }
		]);
	});

	it('returns a copy unchanged for two or fewer points', () => {
		const points: SourcePoint[] = [{ xPx: 1, yPx: 2 }];
		const result = simplifyPolylineRDP(points, 10);
		expect(result).toEqual(points);
		expect(result).not.toBe(points);
	});
});

describe('traceShortestOpenPath', () => {
	const width = 10;
	const height = 10;

	function fullyOpen(): Uint8Array {
		return new Uint8Array(width * height).fill(1);
	}

	it('finds a path across a fully open grid', () => {
		const path = traceShortestOpenPath(fullyOpen(), width, height, { xPx: 0, yPx: 0 }, { xPx: 9, yPx: 9 });
		expect(path).not.toBeNull();
		expect(path?.[0]).toEqual({ xPx: 0, yPx: 0 });
		expect(path?.[path.length - 1]).toEqual({ xPx: 9, yPx: 9 });
	});

	it('routes through a gap in a wall rather than crossing it', () => {
		const open = fullyOpen();
		// A vertical wall at x=5, except for a one-cell gap at y=8.
		for (let y = 0; y < height; y += 1) {
			if (y === 8) continue;
			open[y * width + 5] = 0;
		}
		const path = traceShortestOpenPath(open, width, height, { xPx: 0, yPx: 0 }, { xPx: 9, yPx: 0 });
		expect(path).not.toBeNull();
		expect(path?.some((point) => point.xPx === 5 && point.yPx === 8)).toBe(true);
		expect(path?.some((point) => point.xPx === 5 && point.yPx !== 8)).toBe(false);
	});

	it('returns null when no gap connects the two sides', () => {
		const open = fullyOpen();
		for (let y = 0; y < height; y += 1) open[y * width + 5] = 0;
		const path = traceShortestOpenPath(open, width, height, { xPx: 0, yPx: 0 }, { xPx: 9, yPx: 0 });
		expect(path).toBeNull();
	});

	it('snaps a start/end point to the nearest open cell within the search radius', () => {
		const open = fullyOpen();
		// The literal request points aren't open (a tee pad / basket icon rarely
		// is), but everything around them still is.
		open[1 * width + 1] = 0;
		open[8 * width + 8] = 0;
		const path = traceShortestOpenPath(open, width, height, { xPx: 1, yPx: 1 }, { xPx: 8, yPx: 8 }, 3);
		expect(path).not.toBeNull();
	});

	it('returns null when a point is farther than the search radius from any open cell', () => {
		const open = new Uint8Array(width * height);
		open[0] = 1;
		open[width * height - 1] = 1;
		const path = traceShortestOpenPath(open, width, height, { xPx: 5, yPx: 5 }, { xPx: 9, yPx: 9 }, 1);
		expect(path).toBeNull();
	});

	it('does not throw on a fragmented/maze-like open region whose shortest path exceeds the (width+height) bucket bound', () => {
		// A "comb": every even row is fully open, every odd row has exactly one
		// open cell, alternating ends -- forces any path from one corner to the
		// far corner to snake through nearly every cell, so its weighted length
		// vastly exceeds the (width+height)*DIAGONAL_WEIGHT bucket-array bound
		// traceShortestOpenPath sizes itself to. This must degrade to "no path
		// found" (a sign the classification broke down), never throw.
		const mazeWidth = 60;
		const mazeHeight = 60;
		const maze = new Uint8Array(mazeWidth * mazeHeight);
		for (let y = 0; y < mazeHeight; y += 1) {
			if (y % 2 === 0) {
				for (let x = 0; x < mazeWidth; x += 1) maze[y * mazeWidth + x] = 1;
			}
		}
		for (let y = 1; y < mazeHeight; y += 2) {
			const connectorX = ((y - 1) / 2) % 2 === 0 ? mazeWidth - 1 : 0;
			maze[y * mazeWidth + connectorX] = 1;
		}
		expect(() =>
			traceShortestOpenPath(maze, mazeWidth, mazeHeight, { xPx: 0, yPx: 0 }, { xPx: mazeWidth - 1, yPx: mazeHeight - 2 })
		).not.toThrow();
	});
});

describe('buildTraversabilityMask', () => {
	function raster(pixels: (readonly [number, number, number])[], widthPx: number, heightPx: number): CorridorBendRaster {
		const data = new Uint8ClampedArray(widthPx * heightPx * 4);
		pixels.forEach(([r, g, b], index) => {
			data[index * 4] = r;
			data[index * 4 + 1] = g;
			data[index * 4 + 2] = b;
			data[index * 4 + 3] = 255;
		});
		return { widthPx, heightPx, originXPx: 0, originYPx: 0, scale: 1, data, channels: 4 };
	}

	it('marks pixels within tolerance of a reference color open, others closed', () => {
		const r = raster(
			[
				[80, 160, 80],
				[82, 158, 79],
				[0, 0, 0]
			],
			3,
			1
		);
		const mask = buildTraversabilityMask(r, [[80, 160, 80]], 20);
		expect(Array.from(mask)).toEqual([1, 1, 0]);
	});

	it('matches a pixel against any of several reference colors (OR, not AND)', () => {
		const r = raster(
			[
				[80, 160, 80],
				[200, 200, 200]
			],
			2,
			1
		);
		const mask = buildTraversabilityMask(
			r,
			[
				[80, 160, 80],
				[200, 200, 200]
			],
			5
		);
		expect(Array.from(mask)).toEqual([1, 1]);
	});
});

describe('detectCorridorBends', () => {
	const FAIRWAY: readonly [number, number, number] = [80, 160, 80];
	const BACKGROUND: readonly [number, number, number] = [10, 10, 10];

	function paintRaster(
		widthPx: number,
		heightPx: number,
		isFairway: (x: number, y: number) => boolean
	): CorridorBendRaster {
		const data = new Uint8ClampedArray(widthPx * heightPx * 4);
		for (let y = 0; y < heightPx; y += 1) {
			for (let x = 0; x < widthPx; x += 1) {
				const [r, g, b] = isFairway(x, y) ? FAIRWAY : BACKGROUND;
				const p = (y * widthPx + x) * 4;
				data[p] = r;
				data[p + 1] = g;
				data[p + 2] = b;
				data[p + 3] = 255;
			}
		}
		return { widthPx, heightPx, originXPx: 0, originYPx: 0, scale: 1, data, channels: 4 };
	}

	it('proposes zero bends for a straight hole (uniform fairway crop)', () => {
		const raster = paintRaster(200, 200, () => true);
		const bends = detectCorridorBends(raster, { xPx: 20, yPx: 100 }, { xPx: 180, yPx: 100 });
		expect(bends).toEqual([]);
	});

	// An "L": a vertical strip near the left edge joined to a horizontal strip
	// near the bottom edge. Tee sits in the vertical leg, basket in the
	// horizontal leg — the direct line between them crosses mostly background,
	// so any connecting path must bend around the inner corner near (30, 170).
	function dogleg(): CorridorBendRaster {
		return paintRaster(
			200,
			200,
			(x, y) => (x >= 10 && x <= 50 && y >= 10 && y <= 190) || (y >= 150 && y <= 190 && x >= 10 && x <= 190)
		);
	}
	const tee: SourcePoint = { xPx: 30, yPx: 30 };
	const basket: SourcePoint = { xPx: 170, yPx: 170 };

	it('proposes one or more bends clustered near the turn for a genuine dogleg', () => {
		// The shortest path legitimately cuts the inside of the "L" corner
		// rather than making one sharp right angle (a reasonable approximation
		// of a real fairway), so this can RDP-simplify to a small cluster of
		// vertices around the turn rather than exactly one — bounded by
		// `maxBends`, still nowhere near the straight-hole case (0 bends).
		const bends = detectCorridorBends(dogleg(), tee, basket);
		expect(bends.length).toBeGreaterThanOrEqual(1);
		expect(bends.length).toBeLessThanOrEqual(3);
		for (const bend of bends) {
			expect(bend.xPx).toBeGreaterThanOrEqual(5);
			expect(bend.xPx).toBeLessThanOrEqual(155);
			expect(bend.yPx).toBeGreaterThanOrEqual(120);
			expect(bend.yPx).toBeLessThanOrEqual(195);
		}
	});

	it('suppresses the same dogleg bend when maxDetourRatio is tightened below the traced detour', () => {
		const bends = detectCorridorBends(dogleg(), tee, basket, {
			colorTolerance: 42,
			rdpEpsilonPx: 10,
			minTurnAngleDeg: 12,
			maxDetourRatio: 1.05,
			maxBends: 3,
			referenceSampleRadiusPx: 24
		});
		expect(bends).toEqual([]);
	});

	it('suppresses the same dogleg bend when minTurnAngleDeg is raised above the actual turn', () => {
		const bends = detectCorridorBends(dogleg(), tee, basket, {
			colorTolerance: 42,
			rdpEpsilonPx: 10,
			minTurnAngleDeg: 95,
			maxDetourRatio: 1.6,
			maxBends: 3,
			referenceSampleRadiusPx: 24
		});
		expect(bends).toEqual([]);
	});

	it('proposes zero bends when tee and basket sit in disconnected fairway-colored islands', () => {
		const raster = paintRaster(
			200,
			200,
			(x, y) => (x >= 10 && x <= 50 && y >= 10 && y <= 50) || (x >= 150 && x <= 190 && y >= 150 && y <= 190)
		);
		const bends = detectCorridorBends(raster, { xPx: 30, yPx: 30 }, { xPx: 170, yPx: 170 });
		expect(bends).toEqual([]);
	});

	it('proposes zero bends when tee or basket falls outside the raster bounds', () => {
		const raster = paintRaster(50, 50, () => true);
		const bends = detectCorridorBends(raster, { xPx: -5, yPx: 10 }, { xPx: 40, yPx: 40 });
		expect(bends).toEqual([]);
	});
});

describe('applyDetectedCorridorBends', () => {
	const bendA: SourcePoint = { xPx: 30, yPx: 40 };
	const bendB: SourcePoint = { xPx: 60, yPx: 20 };

	it('adds proposed bends in order to a hole with tee/basket and no existing bends', () => {
		const holes: AnnotatedHole[] = [
			emptyHole('h1', 1, { tee: { xPx: 0, yPx: 0 }, basket: { xPx: 100, yPx: 0 } })
		];
		const result = applyDetectedCorridorBends(holes, 'h1', [bendA, bendB]);
		expect(result[0].corridorBends).toEqual([bendA, bendB]);
		expect(holes[0].corridorBends).toEqual([]);
	});

	it('never clobbers a hole that already has a bend, even with nonempty proposals', () => {
		const existing: SourcePoint = { xPx: 5, yPx: 5 };
		const holes: AnnotatedHole[] = [
			emptyHole('h1', 1, {
				tee: { xPx: 0, yPx: 0 },
				basket: { xPx: 100, yPx: 0 },
				corridorBends: [existing]
			})
		];
		const result = applyDetectedCorridorBends(holes, 'h1', [bendA, bendB]);
		expect(result[0].corridorBends).toEqual([existing]);
	});

	it('is a no-op when the hole is missing a tee or basket', () => {
		const holes: AnnotatedHole[] = [emptyHole('h1', 1, { tee: { xPx: 0, yPx: 0 } })];
		const result = applyDetectedCorridorBends(holes, 'h1', [bendA]);
		expect(result[0].corridorBends).toEqual([]);
	});

	it('is a no-op when no bends are proposed', () => {
		const holes: AnnotatedHole[] = [
			emptyHole('h1', 1, { tee: { xPx: 0, yPx: 0 }, basket: { xPx: 100, yPx: 0 } })
		];
		const result = applyDetectedCorridorBends(holes, 'h1', []);
		expect(result[0].corridorBends).toEqual([]);
	});

	it('leaves other holes untouched', () => {
		const holes: AnnotatedHole[] = [
			emptyHole('h1', 1, { tee: { xPx: 0, yPx: 0 }, basket: { xPx: 100, yPx: 0 } }),
			emptyHole('h2', 2, { tee: { xPx: 0, yPx: 0 }, basket: { xPx: 100, yPx: 0 } })
		];
		const result = applyDetectedCorridorBends(holes, 'h1', [bendA]);
		expect(result[1]).toBe(holes[1]);
	});
});
