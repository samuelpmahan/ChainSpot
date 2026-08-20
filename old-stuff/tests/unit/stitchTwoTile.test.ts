/**
 * Coverage for N-tile sessions below the original fixed four: two tiles
 * (left/right or top/bottom overlap) and three tiles, exercising the same
 * `assignN` arrangement path, `autoCrop`'s multi-tile evidence generalization,
 * and `smartImportFiles`'s end-to-end N-file intake — there is no longer a
 * separate `'1x2'`/`'2x1'` layout concept; every tile count from two upward
 * goes through the same general path.
 *
 * Reuses `smartMap.js`'s synthetic scene (`buildGrayRaster`) for realistic,
 * deterministic content; the `slot` argument it takes only selects a default
 * origin/chrome, both of which are overridden below to build the desired
 * left/right or top/bottom overlap, so passing a 2x2-style slot name there is
 * just reusing the existing scene generator, not claiming a 2x2 layout.
 */
import { describe, expect, test } from 'vitest';
import { assignN } from '../../src/lib/stitch/autoLayout';
import { proposeCropDetailed } from '../../src/lib/stitch/autoCrop';
import { classifyLayout } from '../../src/lib/stitch/diagnostics';
import { smartImportFiles } from '../../src/lib/stitch/smartImport';
import {
	defaultSlotOrder,
	expectedNeighbors,
	gridNeighbors,
	initialPlacements,
	readiness
} from '../../src/lib/stitch/geometry';
import { buildGrayRaster, STEP, TILE_H, TILE_W } from '../helpers/smartMap';

const PLACEMENT_TOLERANCE_PX = 5;
const [T0, T1] = defaultSlotOrder(2);
const TWO_NEIGHBORS = gridNeighbors([T0, T1]);

function fileOf(name: string): File {
	return new File([new Uint8Array(8).fill(1)], name, { type: 'image/png' });
}

function decodedOf(widthPx: number, heightPx: number) {
	return { image: {} as HTMLImageElement, widthPx, heightPx };
}

describe('geometry: two-tile session support', () => {
	test('initialPlacements, expectedNeighbors, and readiness generalize down to two tiles', () => {
		// Same documented 25% overlap rule as a larger session, applied on one axis
		// (two tiles always grid into a single row: ceil(sqrt(2)) = 2 columns).
		const lr = initialPlacements([T0, T1], 1000, 800);
		expect(lr[T0]).toEqual({ xPx: 0, yPx: 0, visible: true });
		expect(lr[T1]).toEqual({ xPx: 750, yPx: 0, visible: true });

		expect(expectedNeighbors(T0, TWO_NEIGHBORS)).toEqual([T1]);
		expect(expectedNeighbors(T1, TWO_NEIGHBORS)).toEqual([T0]);

		// readiness: anchor is the session's first slot, connected through
		// positive-area overlap exactly as a larger session requires.
		const dims = { widthPx: 100, heightPx: 100 };
		const connected = readiness(
			{ [T0]: dims, [T1]: dims },
			{ topPx: 0, rightPx: 0, bottomPx: 0, leftPx: 0 },
			{ [T0]: { xPx: 0, yPx: 0, visible: true }, [T1]: { xPx: 60, yPx: 0, visible: true } },
			dims,
			[T0, T1],
			TWO_NEIGHBORS
		);
		expect(connected.ready).toBe(true);

		const disconnected = readiness(
			{ [T0]: dims, [T1]: dims },
			{ topPx: 0, rightPx: 0, bottomPx: 0, leftPx: 0 },
			{ [T0]: { xPx: 0, yPx: 0, visible: true }, [T1]: { xPx: 500, yPx: 0, visible: true } },
			dims,
			[T0, T1],
			TWO_NEIGHBORS
		);
		expect(disconnected.ready).toBe(false);
		expect(disconnected.disconnected).toEqual([T1]);

		const missingTile = readiness(
			{ [T0]: dims },
			{ topPx: 0, rightPx: 0, bottomPx: 0, leftPx: 0 },
			{ [T0]: { xPx: 0, yPx: 0, visible: true } },
			dims,
			[T0, T1],
			TWO_NEIGHBORS
		);
		expect(missingTile.ready).toBe(false);
		expect(missingTile.missing).toEqual([T1]);
	});
});

describe('autoLayout: assignN with two tiles', () => {
	test('detects a left-right pair regardless of input order and places it within tolerance', async () => {
		const noChrome = { chromeTop: 0, chromeBottom: 0 };
		const leftRaster = buildGrayRaster('upper-left', { ...noChrome, origin: { x: 0, y: 0 } });
		const rightRaster = buildGrayRaster('upper-right', { ...noChrome, origin: { x: STEP, y: 0 } });

		const forward = await assignN([leftRaster, rightRaster]);
		expect(forward.order).toHaveLength(2);
		expect(forward.placementEdges).toHaveLength(1);
		const [edge] = forward.placementEdges;
		// Whichever raster won the anchor role, the other is offset ~150px along
		// whichever axis the real content overlap actually lies on.
		expect(Math.abs(Math.abs(edge.dxPx) - (TILE_W * 3) / 4)).toBeLessThanOrEqual(
			PLACEMENT_TOLERANCE_PX
		);
		expect(edge.dyPx).toBe(0);

		// File-selection order must not determine the geometry: fed in reverse,
		// the same two rasters still resolve to the same (mirrored) offset.
		const backward = await assignN([rightRaster, leftRaster]);
		const [backwardEdge] = backward.placementEdges;
		expect(Math.abs(Math.abs(backwardEdge.dxPx) - (TILE_W * 3) / 4)).toBeLessThanOrEqual(
			PLACEMENT_TOLERANCE_PX
		);

		// The diagnostic path also generalizes: a strong two-tile match is 'ok'.
		const diagnostic = classifyLayout(forward);
		expect(diagnostic.category).toBe('ok');
		expect(diagnostic.warnings).toEqual([]);
	});

	test('detects a top-bottom pair from the same two orientation-agnostic rasters', async () => {
		const noChrome = { chromeTop: 0, chromeBottom: 0 };
		const topRaster = buildGrayRaster('upper-left', { ...noChrome, origin: { x: 0, y: 0 } });
		const bottomRaster = buildGrayRaster('lower-left', { ...noChrome, origin: { x: 0, y: STEP } });

		const layout = await assignN([topRaster, bottomRaster]);
		const [edge] = layout.placementEdges;
		expect(edge.dxPx).toBe(0);
		expect(Math.abs(Math.abs(edge.dyPx) - (TILE_H * 3) / 4)).toBeLessThanOrEqual(
			PLACEMENT_TOLERANCE_PX
		);

		const diagnostic = classifyLayout(layout);
		expect(diagnostic.category).toBe('ok');
	});

	test('rejects a raster count below two', async () => {
		const noChrome = { chromeTop: 0, chromeBottom: 0 };
		const single = [buildGrayRaster('upper-left', noChrome)];
		await expect(assignN(single)).rejects.toThrow('expected at least two rasters');
	});
});

describe('autoCrop: shared crop proposal over two tiles', () => {
	test('proposes the same bounded chrome insets from two rasters as from four', () => {
		const rasters = [buildGrayRaster('upper-left'), buildGrayRaster('upper-right')];
		const proposal = proposeCropDetailed(rasters);
		expect(proposal.insets).toEqual({ topPx: 4, rightPx: 0, bottomPx: 3, leftPx: 0 });
		expect(proposal.confidence).toBe('high');
	});

	test('declines a side where the two tiles disagree', () => {
		const rasters = [
			buildGrayRaster('upper-left'),
			buildGrayRaster('upper-right', { chromeTop: 0 })
		];
		const proposal = proposeCropDetailed(rasters);
		expect(proposal.insets).toEqual({ topPx: 0, rightPx: 0, bottomPx: 3, leftPx: 0 });
	});
});

describe('smartImportFiles: N-file intake', () => {
	test('a valid two-file left-right batch commits a two-tile session', async () => {
		const noChrome = { chromeTop: 0, chromeBottom: 0 };
		const rasters = [
			buildGrayRaster('upper-right', { ...noChrome, origin: { x: STEP, y: 0 } }),
			buildGrayRaster('upper-left', { ...noChrome, origin: { x: 0, y: 0 } })
		];
		const files = [fileOf('right.png'), fileOf('left.png')];
		let index = 0;
		const result = await smartImportFiles(files, {
			decode: async () => decodedOf(TILE_W, TILE_H),
			buildRaster: () => rasters[index++ % rasters.length],
			buildCropRaster: () => rasters[index++ % rasters.length]
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.order).toHaveLength(2);
		expect(Object.values(result.assignment).sort()).toEqual([0, 1]);
		expect(result.diagnostic.category).toBe('ok');
	});

	// A three-file batch was rejected before this generalization pass (smart
	// import only accepted exactly two or four files); it is now the same
	// supported path as any other N >= 2 count.
	test('a three-file batch is now accepted and produces a coherent three-tile session', async () => {
		const noChrome = { chromeTop: 0, chromeBottom: 0 };
		const rasters = [
			buildGrayRaster('upper-left', { ...noChrome, origin: { x: 0, y: 0 } }),
			buildGrayRaster('upper-right', { ...noChrome, origin: { x: STEP, y: 0 } }),
			buildGrayRaster('lower-left', { ...noChrome, origin: { x: 0, y: STEP } })
		];
		const files = [fileOf('a.png'), fileOf('b.png'), fileOf('c.png')];
		let index = 0;
		const result = await smartImportFiles(files, {
			decode: async () => decodedOf(TILE_W, TILE_H),
			buildRaster: () => rasters[index++ % rasters.length],
			buildCropRaster: () => rasters[index++ % rasters.length]
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.order).toHaveLength(3);
		expect(Object.values(result.assignment).sort()).toEqual([0, 1, 2]);
		expect(result.layout.placementEdges).toHaveLength(2);
	});

	test('a single file is rejected as below the minimum, without touching the session', async () => {
		const files = [fileOf('a.png')];
		const result = await smartImportFiles(files, { decode: async () => decodedOf(200, 200) });
		expect(result.ok).toBe(false);
		if (result.ok || 'stale' in result) throw new Error('expected a wrong-count failure');
		expect(result.kind).toBe('wrong-count');
		if (result.kind === 'wrong-count') expect(result.count).toBe(1);
	});
});
