import { describe, expect, test } from 'vitest';
import { assignFour } from '../../src/lib/stitch/autoLayout';
import { smartImportFiles } from '../../src/lib/stitch/smartImport';
import type { SmartImportFileFailureKind, SmartImportResult } from '../../src/lib/stitch/smartImport';
import { TILE_SLOTS } from '../../src/lib/stitch/geometry';
import type { TileSlot } from '../../src/lib/stitch/geometry';
import { buildGrayRaster, TILE_H, TILE_W } from '../helpers/smartMap';

/** The documented tolerance for inferred integer placements, in original px. */
const PLACEMENT_TOLERANCE_PX = 5;

function fileOf(name: string, type: string, size = 8): File {
	return new File([new Uint8Array(size).fill(1)], name, { type });
}

function decodedOf(widthPx: number, heightPx: number) {
	return {
		image: {} as HTMLImageElement,
		widthPx,
		heightPx
	};
}

/** Asserts a per-file failure identifying the offending file and reason. */
function expectFileFailure(
	result: SmartImportResult,
	fileName: string,
	reason: SmartImportFileFailureKind
): void {
	if (result.ok) throw new Error('expected a failure');
	if ('stale' in result) throw new Error('expected a file failure, got stale');
	expect(result.kind).toBe('file');
	if (result.kind !== 'file') return;
	expect(result.reason).toBe(reason);
	expect(result.fileName).toBe(fileName);
}

describe('P1-001 smart four-tile assignment (case 1)', () => {
	test('unordered deterministic fixture produces the expected roles and integer placements', () => {
		// Enter in one nontrivial order: lower-left, upper-right, lower-right,
		// upper-left. File-selection order must not determine the roles.
		const rasters = [
			buildGrayRaster('lower-left'),
			buildGrayRaster('upper-right'),
			buildGrayRaster('lower-right'),
			buildGrayRaster('upper-left')
		];
		const layout = assignFour(rasters);

		// Every 24-permutation scoring path is exercised inside this case; the
		// correct assignment must win.
		expect(layout.assignment).toEqual({
			'upper-left': 3,
			'upper-right': 1,
			'lower-left': 0,
			'lower-right': 2
		});

		// Anchor at (0,0); the other three are integer translation-only placements
		// consistent with 25% overlap on 200x200 tiles (offset 150 per axis).
		const placements = layout.placements;
		expect(placements['upper-left']).toEqual({ xPx: 0, yPx: 0, visible: true });
		expect(Math.abs(placements['upper-right'].xPx - (TILE_W * 3) / 4)).toBeLessThanOrEqual(
			PLACEMENT_TOLERANCE_PX
		);
		expect(placements['upper-right'].yPx).toBe(0);
		expect(placements['lower-left'].xPx).toBe(0);
		expect(Math.abs(placements['lower-left'].yPx - (TILE_H * 3) / 4)).toBeLessThanOrEqual(
			PLACEMENT_TOLERANCE_PX
		);

		// Lower-right is reconciled from the redundant right-column and bottom-row
		// paths rather than one edge alone.
		const expectedX = (TILE_W * 3) / 4;
		const expectedY = (TILE_H * 3) / 4;
		expect(Math.abs(placements['lower-right'].xPx - expectedX)).toBeLessThanOrEqual(
			PLACEMENT_TOLERANCE_PX
		);
		expect(Math.abs(placements['lower-right'].yPx - expectedY)).toBeLessThanOrEqual(
			PLACEMENT_TOLERANCE_PX
		);

		// Diagnostics: the winner beats the runner-up and exposes per-edge scores.
		expect(layout.score).toBeGreaterThan(layout.runnerUpScore);
		expect(layout.separation).toBeGreaterThan(0);
		for (const edge of ['upper-left>upper-right', 'upper-left>lower-left', 'upper-right>lower-right', 'lower-left>lower-right']) {
			expect(layout.edgeScores[edge]).toBeGreaterThan(0);
		}

		// Determinism: a different entry order yields the same slot-to-file mapping.
		const reordered = assignFour([
			rasters[2],
			rasters[3],
			rasters[0],
			rasters[1]
		]);
		for (const slot of TILE_SLOTS) {
			const fileIndex = layout.assignment[slot];
			const expected = reordered.assignment[slot];
			// rasters was rotated by -2: the file now at index `fileIndex` in the
			// first call appears at index ((fileIndex + 2) % 4) in the second.
			expect(((expected + 2) % 4) === fileIndex).toBe(true);
		}
	});
});

describe('P1-001 bulk intake atomicity (case 2)', () => {
	test('wrong count and per-file failures reject the batch and identify the offending file', async () => {
		const decode = async () => decodedOf(200, 200);

		const wrongCount = await smartImportFiles([fileOf('a.png', 'image/png')], { decode });
		expect(wrongCount.ok).toBe(false);
		if (!wrongCount.ok && 'kind' in wrongCount && wrongCount.kind === 'wrong-count') {
			expect(wrongCount.count).toBe(1);
		} else {
			throw new Error('expected wrong-count failure');
		}

		const unsupported = await smartImportFiles(
			[
				fileOf('a.png', 'image/png'),
				fileOf('b.txt', 'text/plain'),
				fileOf('c.png', 'image/png'),
				fileOf('d.png', 'image/png')
			],
			{ decode }
		);
		expectFileFailure(unsupported, 'b.txt', 'unsupported-type');

		const decodeFailure = await smartImportFiles(
			[
				fileOf('a.png', 'image/png'),
				fileOf('broken.png', 'image/png'),
				fileOf('c.png', 'image/png'),
				fileOf('d.png', 'image/png')
			],
			{
				decode: async (file) => {
					if (file.name === 'broken.png') throw new Error('simulated decode failure');
					return decodedOf(200, 200);
				}
			}
		);
		expectFileFailure(decodeFailure, 'broken.png', 'decode-failure');

		const invalidDims = await smartImportFiles(
			[
				fileOf('a.png', 'image/png'),
				fileOf('zero.png', 'image/png'),
				fileOf('c.png', 'image/png'),
				fileOf('d.png', 'image/png')
			],
			{
				decode: async (file) => (file.name === 'zero.png' ? decodedOf(0, 200) : decodedOf(200, 200))
			}
		);
		expectFileFailure(invalidDims, 'zero.png', 'invalid-dimension');

		const mismatch = await smartImportFiles(
			[
				fileOf('a.png', 'image/png'),
				fileOf('wide.png', 'image/png'),
				fileOf('c.png', 'image/png'),
				fileOf('d.png', 'image/png')
			],
			{
				decode: async (file) => (file.name === 'wide.png' ? decodedOf(201, 200) : decodedOf(200, 200))
			}
		);
		expectFileFailure(mismatch, 'wide.png', 'dimension-mismatch');
	});

	test('a stale batch never publishes a success or a failure', async () => {
		let current = true;
		let resolveDecode!: (value: { image: HTMLImageElement; widthPx: number; heightPx: number }) => void;
		const gate = new Promise<{ image: HTMLImageElement; widthPx: number; heightPx: number }>(
			(resolve) => (resolveDecode = resolve)
		);
		const files = ['a.png', 'b.png', 'c.png', 'd.png'].map((name) => fileOf(name, 'image/png'));
		const pending = smartImportFiles(files, {
			decode: () => gate,
			isCurrent: () => current
		});
		// A newer selection/reset invalidates the batch before the first decode
		// settles; the late success must be reported as stale.
		current = false;
		resolveDecode(decodedOf(200, 200));
		const result = await pending;
		expect(result).toEqual({ ok: false, stale: true });
	});

	test('a valid unordered batch commits one coherent result with a bounded crop proposal', async () => {
		const rasters = [
			buildGrayRaster('lower-left'),
			buildGrayRaster('upper-right'),
			buildGrayRaster('lower-right'),
			buildGrayRaster('upper-left')
		];
		const files = ['ll.png', 'ur.png', 'lr.png', 'ul.png'].map((name) => fileOf(name, 'image/png'));
		let rasterIndex = 0;
		const result = await smartImportFiles(files, {
			decode: async () => decodedOf(200, 200),
			buildRaster: () => rasters[rasterIndex++]
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.tiles).toHaveLength(4);
		expect(result.tiles.map((tile) => tile.fileName)).toEqual(['ll.png', 'ur.png', 'lr.png', 'ul.png']);
		expect(result.tiles.every((tile) => tile.widthPx === 200 && tile.heightPx === 200)).toBe(true);
		expect(result.assignment).toEqual({
			'upper-left': 3,
			'upper-right': 1,
			'lower-left': 0,
			'lower-right': 2
		});

		const placements = result.placements;
		for (const slot of TILE_SLOTS as TileSlot[]) {
			expect(Number.isInteger(placements[slot].xPx)).toBe(true);
			expect(Number.isInteger(placements[slot].yPx)).toBe(true);
			expect(placements[slot].visible).toBe(true);
		}
		expect(placements['upper-left']).toEqual({ xPx: 0, yPx: 0, visible: true });
		expect(Math.abs(placements['upper-right'].xPx - (TILE_W * 3) / 4)).toBeLessThanOrEqual(
			PLACEMENT_TOLERANCE_PX
		);
		expect(Math.abs(placements['lower-right'].xPx - (TILE_W * 3) / 4)).toBeLessThanOrEqual(
			PLACEMENT_TOLERANCE_PX
		);
		expect(Math.abs(placements['lower-right'].yPx - (TILE_H * 3) / 4)).toBeLessThanOrEqual(
			PLACEMENT_TOLERANCE_PX
		);

		// The shared top/bottom chrome bands are proposed; left/right are not.
		expect(result.cropProposal).toEqual({ topPx: 4, rightPx: 0, bottomPx: 3, leftPx: 0 });
	});
});
