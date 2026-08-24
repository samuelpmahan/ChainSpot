import { describe, expect, test } from 'vitest';
import {
	FALLBACK_GAP_PX,
	initialSpreadPlacements,
	solvePixelStitch,
	trySemanticAlign,
	type BadgeCenter
} from '@chainspot/alg/g0/stitchSolve';
import type { GrayRaster } from '@chainspot/alg';

describe('initialSpreadPlacements', () => {
	test('lays tiles left to right with the fallback gap between them', () => {
		expect(initialSpreadPlacements([100, 200, 50])).toEqual([
			{ x: 0, y: 0 },
			{ x: 100 + FALLBACK_GAP_PX, y: 0 },
			{ x: 100 + FALLBACK_GAP_PX + 200 + FALLBACK_GAP_PX, y: 0 }
		]);
	});
});

describe('trySemanticAlign', () => {
	function badges(...entries: [number, number, number][]): BadgeCenter[] {
		return entries.map(([n, x, y]) => ({ n, x, y }));
	}

	test('aligns a matching tile to the anchor by median badge offset', () => {
		const anchor = badges([1, 10, 10], [2, 50, 10]);
		// tile 1's badges are the SAME real-world badges, shifted by (+100, +5)
		const tile1 = badges([1, -90, 5], [2, -50, 5]);
		const placements = [
			{ x: 0, y: 0 },
			{ x: 999, y: 999 } // deliberately wrong starting placement — must be overwritten
		];

		const result = trySemanticAlign([anchor, tile1], placements);

		expect(result).not.toBeNull();
		expect(result!.placements[0]).toEqual({ x: 0, y: 0 });
		expect(result!.placements[1]).toEqual({ x: 100, y: 5 });
		expect(result!.matches).toEqual([{ tileIndex: 1, badgeNumbers: [1, 2] }]);
	});

	test('a tile with zero shared badge numbers is left at its current placement, as long as some OTHER tile matched', () => {
		// trySemanticAlign only returns a result at all when at least one tile
		// matched anywhere (mirrors the page: matchedTiles.length === 0 is a
		// total no-op) — with a genuine mixed set, the non-matching tile's
		// placement passes through untouched while the matching one moves.
		const anchor = badges([1, 10, 10]);
		const matching = badges([1, -90, 5]); // shares badge 1 with anchor
		const noMatch = badges([9, 0, 0]); // shares nothing
		const placements = [
			{ x: 0, y: 0 },
			{ x: 999, y: 999 },
			{ x: 42, y: 7 }
		];

		const result = trySemanticAlign([anchor, matching, noMatch], placements);

		expect(result).not.toBeNull();
		expect(result!.placements[1]).toEqual({ x: 100, y: 5 });
		expect(result!.placements[2]).toEqual({ x: 42, y: 7 });
		expect(result!.matches).toEqual([{ tileIndex: 1, badgeNumbers: [1] }]);
	});

	test('nothing matches anywhere -> null (caller keeps the prior layout)', () => {
		const anchor = badges([1, 10, 10]);
		const noMatch = badges([9, 0, 0]);

		expect(
			trySemanticAlign(
				[anchor, noMatch],
				[
					{ x: 0, y: 0 },
					{ x: 1, y: 1 }
				]
			)
		).toBeNull();
	});

	test('empty anchor -> null', () => {
		expect(
			trySemanticAlign(
				[[], badges([1, 0, 0])],
				[
					{ x: 0, y: 0 },
					{ x: 1, y: 1 }
				]
			)
		).toBeNull();
	});

	test('fewer than two tiles -> null', () => {
		expect(trySemanticAlign([badges([1, 0, 0])], [{ x: 0, y: 0 }])).toBeNull();
	});
});

function worldPixel(x: number, y: number): number {
	return ((x * 73) ^ (y * 151) ^ (x * y * 29)) & 255;
}

function rasterFromWorld(originX: number, originY: number, widthPx = 32, heightPx = 28): GrayRaster {
	const gray = new Uint8Array(widthPx * heightPx);
	for (let y = 0; y < heightPx; y++) {
		for (let x = 0; x < widthPx; x++) {
			gray[y * widthPx + x] = worldPixel(originX + x, originY + y);
		}
	}
	return { widthPx, heightPx, gray };
}

describe('solvePixelStitch', () => {
	test('fewer than two rasters -> null', () => {
		expect(solvePixelStitch([rasterFromWorld(0, 0)])).toBeNull();
	});

	test('accumulates pairwise offsets left to right with no fallback when every pair overlaps', () => {
		const tiles = [rasterFromWorld(0, 0), rasterFromWorld(9, -6), rasterFromWorld(20, 4)];

		const result = solvePixelStitch(tiles)!;

		expect(result.hadFallback).toBe(false);
		expect(result.placements[0]).toEqual({ x: 0, y: 0 });
		// tile1 is world-origin (9,-6) relative to tile0's (0,0) -> offset (9,-6)
		expect(result.placements[1]).toEqual({ x: 9, y: -6 });
		// tile2 is (20,4) in world coords, i.e. (11,10) relative to tile1's (9,-6),
		// accumulated onto tile1's placement: (9+11, -6+10)
		expect(result.placements[2]).toEqual({ x: 20, y: 4 });
	});

	test('a pair with no plausible overlap falls back to the fixed gap and flags hadFallback', () => {
		// extreme aspect-ratio mismatch (60x1 vs 1x60): the maximum possible
		// overlap area (at dx=0,dy=0) is 1x1=1px, below findBestTranslation's
		// MIN_OVERLAP_FRACTION floor for either raster's area — no offset in
		// the search range ever qualifies, so findBestTranslation is
		// guaranteed to return null here (verified against its own overlap
		// math, not by luck).
		const wide: GrayRaster = { widthPx: 60, heightPx: 1, gray: new Uint8Array(60).fill(7) };
		const tall: GrayRaster = { widthPx: 1, heightPx: 60, gray: new Uint8Array(60).fill(9) };

		const result = solvePixelStitch([wide, tall])!;

		expect(result.hadFallback).toBe(true);
		expect(result.placements).toEqual([
			{ x: 0, y: 0 },
			{ x: 60 + FALLBACK_GAP_PX, y: 0 }
		]);
	});
});
