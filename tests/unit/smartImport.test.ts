import { describe, expect, test } from 'vitest';
import { assignN } from '../../src/lib/stitch/autoLayout';
import type { AutoLayout } from '../../src/lib/stitch/autoLayout';
import { smartImportFiles } from '../../src/lib/stitch/smartImport';
import type { SmartImportFileFailureKind, SmartImportResult } from '../../src/lib/stitch/smartImport';
import type { TilePlacement, TileSlot } from '../../src/lib/stitch/geometry';
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

/** Each corner fixture's true origin in the shared 350x350 synthetic course (see smartMap.js). */
const CORNER_ORIGIN: Record<string, { x: number; y: number }> = {
	'upper-left': { x: 0, y: 0 },
	'upper-right': { x: (TILE_W * 3) / 4, y: 0 },
	'lower-left': { x: 0, y: (TILE_H * 3) / 4 },
	'lower-right': { x: (TILE_W * 3) / 4, y: (TILE_H * 3) / 4 }
};

/**
 * Asserts every placement edge's measured offset matches the true relative
 * geometry between the corners it connects, however `assignN` chose to
 * label/anchor them — `assignN`'s output slot ids are dynamic (`tile-0`,
 * `tile-1`, ...), not the fixed named corners the old `assignFour` produced,
 * so tests can no longer assert a specific slot-to-file mapping; they assert
 * the arrangement is geometrically correct instead.
 */
function expectGeometricallyCorrectEdges(layout: AutoLayout, cornerOfIndex: readonly string[]): void {
	expect(layout.placementEdges).toHaveLength(layout.order.length - 1);
	for (const edge of layout.placementEdges) {
		const fromIndex = layout.assignment[edge.from];
		const toIndex = layout.assignment[edge.to];
		if (fromIndex === undefined || toIndex === undefined) throw new Error('missing assignment');
		const fromCorner = CORNER_ORIGIN[cornerOfIndex[fromIndex]];
		const toCorner = CORNER_ORIGIN[cornerOfIndex[toIndex]];
		expect(Math.abs(edge.dxPx - (toCorner.x - fromCorner.x))).toBeLessThanOrEqual(
			PLACEMENT_TOLERANCE_PX
		);
		expect(Math.abs(edge.dyPx - (toCorner.y - fromCorner.y))).toBeLessThanOrEqual(
			PLACEMENT_TOLERANCE_PX
		);
		expect(edge.score).toBeGreaterThan(0.5);
	}
}

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

describe('P1-001 N-tile assignment (case 1)', () => {
	test('unordered deterministic fixture produces a geometrically correct, deterministic arrangement', async () => {
		// Enter in one nontrivial order: lower-left, upper-right, lower-right,
		// upper-left. File-selection order must not determine the geometry.
		//
		// `assignN` is exercised directly here, with no crop stage in front of it
		// - in production it only ever receives rasters built from the post-crop
		// interior (see `matcherRegionFromCrop` in src/lib/stitch/smartImport.ts).
		// The `chromeTop`/`chromeBottom` overrides strip the fixture's synthetic
		// top/bottom chrome band to match that: the band is identical on every
		// tile, so it carries zero positional information, but it is a strong
		// dark outlier against the scene content, and under `cvMatch`'s
		// normalized cross-correlation it injects a spurious covariance term
		// whenever one tile's band aligns with another's, dragging the true
		// vertical peak off-target. Feeding it here would test a raster shape
		// `assignN` never actually sees.
		const noChrome = { chromeTop: 0, chromeBottom: 0 };
		const cornerOfIndex = ['lower-left', 'upper-right', 'lower-right', 'upper-left'] as const;
		const rasters = cornerOfIndex.map((corner) => buildGrayRaster(corner, noChrome));
		const layout = await assignN(rasters);

		// Every raster is assigned to exactly one slot (a bijection), the anchor
		// sits at the origin, and every placement is an integer.
		const assignedIndices = Object.values(layout.assignment).sort();
		expect(assignedIndices).toEqual([0, 1, 2, 3]);
		const anchor = layout.order[0];
		expect(layout.placements[anchor]).toEqual({ xPx: 0, yPx: 0, visible: true });
		for (const slot of layout.order) {
			const placement = layout.placements[slot];
			if (!placement) throw new Error(`missing placement for ${slot}`);
			expect(Number.isInteger(placement.xPx)).toBe(true);
			expect(Number.isInteger(placement.yPx)).toBe(true);
		}

		// Three placement edges (a spanning tree over four tiles), each matching
		// the true corner-to-corner geometry within the documented tolerance.
		expectGeometricallyCorrectEdges(layout, cornerOfIndex);
		expect(layout.score).toBeGreaterThan(0);

		// Determinism: the same input always produces the same output.
		const repeat = await assignN(rasters);
		expect(repeat.assignment).toEqual(layout.assignment);
		expect(repeat.placements).toEqual(layout.placements);
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

		// A valid unordered batch commits one coherent, geometrically correct
		// result with a bounded crop proposal: the same single-session
		// replacement semantics the failures above protect.
		const cornerOfIndex = ['lower-left', 'upper-right', 'lower-right', 'upper-left'] as const;
		const rasters = cornerOfIndex.map((corner) => buildGrayRaster(corner));
		const files = ['ll.png', 'ur.png', 'lr.png', 'ul.png'].map((name) => fileOf(name, 'image/png'));
		let rasterIndex = 0;
		let cropRasterIndex = 0;
		const matcherRegions: Array<{ x: number; y: number; width: number; height: number } | undefined> =
			[];
		const ok = await smartImportFiles(files, {
			decode: async () => decodedOf(200, 200),
			// This fixture exercises the raw detected boundary (and the matcher
			// region it drives), not the separate safety-margin feature.
			applyCropMargin: false,
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
		expect(Object.values(ok.assignment).sort()).toEqual([0, 1, 2, 3]);

		// `smartImportFiles` on four files always populates all four slots.
		const placements = ok.placements as Record<TileSlot, TilePlacement>;
		for (const slot of ok.order) {
			expect(Number.isInteger(placements[slot].xPx)).toBe(true);
			expect(Number.isInteger(placements[slot].yPx)).toBe(true);
			expect(placements[slot].visible).toBe(true);
		}
		expectGeometricallyCorrectEdges(ok.layout, cornerOfIndex);

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
