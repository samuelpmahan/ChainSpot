import { describe, expect, test } from 'vitest';
import { assignFour, reconcilePlacements } from '../../src/lib/stitch/autoLayout';
import { smartImportFiles } from '../../src/lib/stitch/smartImport';
import type { SmartImportFileFailureKind, SmartImportResult } from '../../src/lib/stitch/smartImport';
import { TILE_SLOTS } from '../../src/lib/stitch/geometry';
import type { TileSlot } from '../../src/lib/stitch/geometry';
import type { PairEstimate } from '../../src/lib/stitch/analysis';
import { buildGrayRaster, TILE_H, TILE_W } from '../helpers/smartMap';
import type { RasterRegion } from '../../src/lib/stitch/analysis';

/**
 * Slices a full-frame synthetic gray raster down to a `region` sub-rectangle,
 * mirroring what the real `toAnalysisRaster` does when handed a `region`
 * (`src/lib/stitch/analysis.ts`). The case-2 fixture below injects a fake
 * `buildRaster` to observe the region the production code computes; that fake
 * must actually crop to it, or it silently feeds the matcher whole,
 * chrome-carrying frames while asserting the crop math is correct — see the
 * comment at its call site.
 */
function sliceGrayRaster(
	raster: { widthPx: number; heightPx: number; gray: Uint8Array; scale: number },
	region: RasterRegion
): { widthPx: number; heightPx: number; gray: Uint8Array; scale: number } {
	const gray = new Uint8Array(region.width * region.height);
	for (let y = 0; y < region.height; y += 1) {
		const srcRowStart = (region.y + y) * raster.widthPx + region.x;
		gray.set(raster.gray.subarray(srcRowStart, srcRowStart + region.width), y * region.width);
	}
	return { widthPx: region.width, heightPx: region.height, gray, scale: raster.scale };
}

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
	test('unordered deterministic fixture produces the expected roles and integer placements', async () => {
		// Enter in one nontrivial order: lower-left, upper-right, lower-right,
		// upper-left. File-selection order must not determine the roles.
		//
		// `assignFour` is exercised directly here, with no crop stage in front of
		// it - in production it only ever receives rasters built from the
		// post-crop interior (see `matcherRegionFromCrop` in
		// src/lib/stitch/smartImport.ts). The `chromeTop`/`chromeBottom`
		// overrides strip the fixture's synthetic top/bottom chrome band to match
		// that: the band is identical on every tile, so it carries zero
		// positional information, but it is a strong dark outlier against the
		// scene content, and under `cvMatch`'s normalized cross-correlation it
		// injects a spurious covariance term whenever one tile's band aligns with
		// another's, dragging the true vertical peak off-target. Feeding it here
		// would test a raster shape assignFour never actually sees.
		const noChrome = { chromeTop: 0, chromeBottom: 0 };
		const rasters = [
			buildGrayRaster('lower-left', noChrome),
			buildGrayRaster('upper-right', noChrome),
			buildGrayRaster('lower-right', noChrome),
			buildGrayRaster('upper-left', noChrome)
		];
		const layout = await assignFour(rasters);

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

		// The reconciliation helper reproduces the shipped placements exactly on
		// this ideal fixture.
		const a = layout.assignment;
		const ulur = layout.estimates[`${a['upper-left']}>${a['upper-right']}`]['left-right'];
		const ulll = layout.estimates[`${a['upper-left']}>${a['lower-left']}`]['top-bottom'];
		const urlr = layout.estimates[`${a['upper-right']}>${a['lower-right']}`]['top-bottom'];
		const llr = layout.estimates[`${a['lower-left']}>${a['lower-right']}`]['left-right'];
		const reconciled = reconcilePlacements(ulur, ulll, urlr, llr);
		expect(reconciled.upperRight).toEqual({
			xPx: placements['upper-right'].xPx,
			yPx: placements['upper-right'].yPx
		});
		expect(reconciled.lowerLeft).toEqual({
			xPx: placements['lower-left'].xPx,
			yPx: placements['lower-left'].yPx
		});
		expect(reconciled.lowerRight).toEqual({
			xPx: placements['lower-right'].xPx,
			yPx: placements['lower-right'].yPx
		});

		// A hand-built inconsistent edge set — the four measurements disagree,
		// exactly as a real hand-held capture's irregular per-pair overlap would.
		// Upper-right and lower-left must stay EXACTLY their own raw
		// measurement — never adjusted to make another edge's measurement
		// "agree" — while lower-right (the one point with no direct anchor
		// measurement) legitimately averages its two paths.
		const edgeEstimate = (
			orientation: 'left-right' | 'top-bottom',
			dxPx: number,
			dyPx: number
		): PairEstimate => ({
			orientation,
			dxPx,
			dyPx,
			score: 0.9,
			overlapFractionPx: 0.25,
			runnerUpScore: 0.5
		});
		const inconsistent = reconcilePlacements(
			edgeEstimate('left-right', 160, 0),
			edgeEstimate('top-bottom', 10, 0),
			edgeEstimate('top-bottom', -5, 150),
			edgeEstimate('left-right', 140, 150)
		);
		expect(inconsistent.upperRight).toEqual({ xPx: 160, yPx: 0 });
		expect(inconsistent.lowerLeft).toEqual({ xPx: 10, yPx: 0 });
		// viaRight = upperRight + urlr = (155, 150); viaBottom = lowerLeft + llr
		// = (150, 150); lowerRight is their rounded average.
		expect(inconsistent.lowerRight).toEqual({ xPx: 153, yPx: 150 });

		// Diagnostics: the winning assignment's own score is positive and every
		// expected edge exposes a positive per-edge score through `estimates`
		// (the raw evidence `AutoLayout` still carries; `edgeScores` itself is a
		// deleted dead field, not a signal any caller reads).
		expect(layout.score).toBeGreaterThan(0);
		const expectedEdges: readonly { from: TileSlot; to: TileSlot; orientation: 'left-right' | 'top-bottom' }[] = [
			{ from: 'upper-left', to: 'upper-right', orientation: 'left-right' },
			{ from: 'upper-left', to: 'lower-left', orientation: 'top-bottom' },
			{ from: 'upper-right', to: 'lower-right', orientation: 'top-bottom' },
			{ from: 'lower-left', to: 'lower-right', orientation: 'left-right' }
		];
		for (const edge of expectedEdges) {
			const from = layout.assignment[edge.from];
			const to = layout.assignment[edge.to];
			const score = layout.estimates[`${from}>${to}`]?.[edge.orientation]?.score ?? 0;
			expect(score).toBeGreaterThan(0);
		}

		// Determinism: a different entry order yields the same slot-to-file mapping.
		const reordered = await assignFour([
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
	test('wrong count, per-file failures, stale batches, and a valid unordered batch all behave atomically', async () => {
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

		// A newer selection/reset invalidates the batch before the first decode
		// settles; the late success must be reported as stale.
		let current = true;
		let resolveDecode!: (value: { image: HTMLImageElement; widthPx: number; heightPx: number }) => void;
		const gate = new Promise<{ image: HTMLImageElement; widthPx: number; heightPx: number }>(
			(resolve) => (resolveDecode = resolve)
		);
		const staleFiles = ['a.png', 'b.png', 'c.png', 'd.png'].map((name) => fileOf(name, 'image/png'));
		const pending = smartImportFiles(staleFiles, {
			decode: () => gate,
			isCurrent: () => current
		});
		current = false;
		resolveDecode(decodedOf(200, 200));
		const result = await pending;
		expect(result).toEqual({ ok: false, stale: true });

		// A valid unordered batch commits one coherent result with a bounded crop
		// proposal: the same single-session replacement semantics the failures
		// above protect.
		const rasters = [
			buildGrayRaster('lower-left'),
			buildGrayRaster('upper-right'),
			buildGrayRaster('lower-right'),
			buildGrayRaster('upper-left')
		];
		const files = ['ll.png', 'ur.png', 'lr.png', 'ul.png'].map((name) => fileOf(name, 'image/png'));
		let rasterIndex = 0;
		let cropRasterIndex = 0;
		const matcherRegions: Array<{ x: number; y: number; width: number; height: number } | undefined> =
			[];
		const ok = await smartImportFiles(files, {
			decode: async () => decodedOf(200, 200),
			buildRaster: (_image, region) => {
				matcherRegions.push(region);
				// The real `toAnalysisRaster` draws only from `region` when one is
				// given (src/lib/stitch/analysis.ts), so this fake must crop to it
				// too. Returning the untrimmed 200x200 raster here would still let
				// the region-value assertion below pass while secretly feeding the
				// matcher the chrome band the crop was computed to remove -
				// defeating the very thing this fixture exists to exercise: chrome
				// is a uniform band shared by every tile, so it carries zero
				// positional information but is a strong dark outlier that corrupts
				// normalized cross-correlation's vertical peak (see cvMatch.ts).
				const raster = rasters[rasterIndex++];
				return region ? sliceGrayRaster(raster, region) : raster;
			},
			buildCropRaster: () => rasters[cropRasterIndex++ % rasters.length]
		});
		expect(ok.ok).toBe(true);
		if (!ok.ok) return;

		expect(ok.tiles).toHaveLength(4);
		expect(ok.tiles.map((tile) => tile.fileName)).toEqual(['ll.png', 'ur.png', 'lr.png', 'ul.png']);
		expect(ok.tiles.every((tile) => tile.widthPx === 200 && tile.heightPx === 200)).toBe(true);
		expect(ok.assignment).toEqual({
			'upper-left': 3,
			'upper-right': 1,
			'lower-left': 0,
			'lower-right': 2
		});

		const placements = ok.placements;
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
		expect(ok.cropProposal).toEqual({ topPx: 4, rightPx: 0, bottomPx: 3, leftPx: 0 });

		// This fixture's crop confidence is high, so every matcher raster is built
		// from the cropped interior (the same shared insets on all four tiles),
		// not the whole 200x200 frame: crop detection runs before matcher-raster
		// construction and feeds it, instead of the two running independently.
		expect(ok.crop.confidence).toBe('high');
		expect(matcherRegions).toEqual([
			{ x: 0, y: 4, width: 200, height: 193 },
			{ x: 0, y: 4, width: 200, height: 193 },
			{ x: 0, y: 4, width: 200, height: 193 },
			{ x: 0, y: 4, width: 200, height: 193 }
		]);
	});
});
