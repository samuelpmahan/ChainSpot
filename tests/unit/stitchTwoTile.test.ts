/**
 * Coverage for the 1x2 (left/right) and 2x1 (top/bottom) two-tile layouts
 * added alongside the original 2x2 grid: geometry's layout-aware slot lists,
 * `assignTwo`'s orientation/order auto-detection, `autoCrop`'s two-tile
 * evidence path, and `smartImportFiles`'s end-to-end two-file intake.
 *
 * Reuses `smartMap.js`'s synthetic scene (`buildGrayRaster`) for realistic,
 * deterministic content; the `slot` argument it takes only selects a default
 * origin/chrome, both of which are overridden below to build the desired
 * left/right or top/bottom overlap, so passing a 2x2 slot name there is just
 * reusing the existing scene generator, not claiming a 2x2 layout.
 */
import { describe, expect, test } from 'vitest';
import { assignTwo, expectedEdgesForLayout, layoutForSlots } from '../../src/lib/stitch/autoLayout';
import { proposeCropDetailed } from '../../src/lib/stitch/autoCrop';
import { classifyLayout } from '../../src/lib/stitch/diagnostics';
import { smartImportFiles } from '../../src/lib/stitch/smartImport';
import {
	TILE_SLOTS_BY_LAYOUT,
	expectedNeighbors,
	initialPlacements,
	readiness
} from '../../src/lib/stitch/geometry';
import { buildGrayRaster, STEP, TILE_H, TILE_W } from '../helpers/smartMap';

const PLACEMENT_TOLERANCE_PX = 5;

function fileOf(name: string): File {
	return new File([new Uint8Array(8).fill(1)], name, { type: 'image/png' });
}

function decodedOf(widthPx: number, heightPx: number) {
	return { image: {} as HTMLImageElement, widthPx, heightPx };
}

describe('geometry: 1x2/2x1 layout support', () => {
	test('TILE_SLOTS_BY_LAYOUT, initialPlacements, expectedNeighbors, and readiness generalize beyond 2x2', () => {
		expect(TILE_SLOTS_BY_LAYOUT['1x2']).toEqual(['left', 'right']);
		expect(TILE_SLOTS_BY_LAYOUT['2x1']).toEqual(['top', 'bottom']);

		// Same documented 25% overlap rule as the 2x2 layout, applied on one axis.
		const lr = initialPlacements(1000, 800, '1x2');
		expect(lr.left).toEqual({ xPx: 0, yPx: 0, visible: true });
		expect(lr.right).toEqual({ xPx: 750, yPx: 0, visible: true });

		const tb = initialPlacements(1000, 800, '2x1');
		expect(tb.top).toEqual({ xPx: 0, yPx: 0, visible: true });
		expect(tb.bottom).toEqual({ xPx: 0, yPx: 600, visible: true });

		expect(expectedNeighbors('left', '1x2')).toEqual(['right']);
		expect(expectedNeighbors('right', '1x2')).toEqual(['left']);
		expect(expectedNeighbors('top', '2x1')).toEqual(['bottom']);
		expect(expectedNeighbors('bottom', '2x1')).toEqual(['top']);

		// readiness: anchor is the layout's first slot ('left'/'top'), connected
		// through positive-area overlap exactly as the 2x2 layout requires.
		const dims = { widthPx: 100, heightPx: 100 };
		const connected = readiness(
			{ left: dims, right: dims },
			{ topPx: 0, rightPx: 0, bottomPx: 0, leftPx: 0 },
			{ left: { xPx: 0, yPx: 0, visible: true }, right: { xPx: 60, yPx: 0, visible: true } },
			dims,
			'1x2'
		);
		expect(connected.ready).toBe(true);

		const disconnected = readiness(
			{ left: dims, right: dims },
			{ topPx: 0, rightPx: 0, bottomPx: 0, leftPx: 0 },
			{ left: { xPx: 0, yPx: 0, visible: true }, right: { xPx: 500, yPx: 0, visible: true } },
			dims,
			'1x2'
		);
		expect(disconnected.ready).toBe(false);
		expect(disconnected.disconnected).toEqual(['right']);

		const missingTile = readiness(
			{ left: dims },
			{ topPx: 0, rightPx: 0, bottomPx: 0, leftPx: 0 },
			{ left: { xPx: 0, yPx: 0, visible: true } },
			dims,
			'1x2'
		);
		expect(missingTile.ready).toBe(false);
		expect(missingTile.missing).toEqual(['right']);
	});
});

describe('autoLayout: assignTwo (1x2/2x1 auto-detection)', () => {
	test('detects a left-right pair regardless of input order and places it within tolerance', async () => {
		const noChrome = { chromeTop: 0, chromeBottom: 0 };
		const leftRaster = buildGrayRaster('upper-left', { ...noChrome, origin: { x: 0, y: 0 } });
		const rightRaster = buildGrayRaster('upper-right', { ...noChrome, origin: { x: STEP, y: 0 } });

		const forward = await assignTwo([leftRaster, rightRaster]);
		expect(layoutForSlots(Object.keys(forward.assignment) as ('left' | 'right')[])).toBe('1x2');
		expect(forward.assignment).toEqual({ left: 0, right: 1 });
		const forwardRight = forward.placements.right;
		if (!forwardRight) throw new Error('expected a right placement');
		expect(Math.abs(forwardRight.xPx - (TILE_W * 3) / 4)).toBeLessThanOrEqual(PLACEMENT_TOLERANCE_PX);
		expect(forwardRight.yPx).toBe(0);

		// File-selection order must not determine the result: fed in reverse, the
		// same two rasters still resolve to the same left/right roles.
		const backward = await assignTwo([rightRaster, leftRaster]);
		expect(backward.assignment).toEqual({ left: 1, right: 0 });
		const backwardRight = backward.placements.right;
		if (!backwardRight) throw new Error('expected a right placement');
		expect(Math.abs(backwardRight.xPx - (TILE_W * 3) / 4)).toBeLessThanOrEqual(PLACEMENT_TOLERANCE_PX);

		// The diagnostic path also generalizes: a strong two-tile match is 'ok'.
		const diagnostic = classifyLayout(forward, '1x2');
		expect(diagnostic.category).toBe('ok');
		expect(diagnostic.warnings).toEqual([]);
		expect(expectedEdgesForLayout('1x2')).toEqual([
			{ from: 'left', to: 'right', orientation: 'left-right' }
		]);
	});

	test('detects a top-bottom pair from the same two orientation-agnostic rasters', async () => {
		const noChrome = { chromeTop: 0, chromeBottom: 0 };
		const topRaster = buildGrayRaster('upper-left', { ...noChrome, origin: { x: 0, y: 0 } });
		const bottomRaster = buildGrayRaster('lower-left', { ...noChrome, origin: { x: 0, y: STEP } });

		const layout = await assignTwo([topRaster, bottomRaster]);
		expect(layoutForSlots(Object.keys(layout.assignment) as ('top' | 'bottom')[])).toBe('2x1');
		expect(layout.assignment).toEqual({ top: 0, bottom: 1 });
		const bottom = layout.placements.bottom;
		if (!bottom) throw new Error('expected a bottom placement');
		expect(bottom.xPx).toBe(0);
		expect(Math.abs(bottom.yPx - (TILE_H * 3) / 4)).toBeLessThanOrEqual(PLACEMENT_TOLERANCE_PX);

		const diagnostic = classifyLayout(layout, '2x1');
		expect(diagnostic.category).toBe('ok');
	});

	test('rejects a raster count other than two', async () => {
		const noChrome = { chromeTop: 0, chromeBottom: 0 };
		const single = [buildGrayRaster('upper-left', noChrome)];
		await expect(assignTwo(single)).rejects.toThrow('expected exactly two rasters');
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

describe('smartImportFiles: two-file intake auto-detects the layout', () => {
	test('a valid two-file left-right batch commits a 1x2 session', async () => {
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
		expect(result.layoutKind).toBe('1x2');
		expect(Object.keys(result.assignment).sort()).toEqual(['left', 'right']);
		expect(result.assignment.left).toBe(1);
		expect(result.assignment.right).toBe(0);
		expect(result.diagnostic.category).toBe('ok');
	});

	test('an unsupported file count (three) is rejected without touching the session', async () => {
		const files = [fileOf('a.png'), fileOf('b.png'), fileOf('c.png')];
		const result = await smartImportFiles(files, { decode: async () => decodedOf(200, 200) });
		expect(result.ok).toBe(false);
		if (result.ok || 'stale' in result) throw new Error('expected a wrong-count failure');
		expect(result.kind).toBe('wrong-count');
		if (result.kind === 'wrong-count') expect(result.count).toBe(3);
	});
});
