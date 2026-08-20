/**
 * Coverage for `stitchPipeline.ts`'s `runStitchPipeline` (CHSPT-50/55/56):
 * N=1 and N>1 through the one entry point, `coveragePolygon`/`paintOrder`
 * correctness checked against `domain/provenance.ts`'s own
 * `assertCoherentProvenance` (its own correctness check, per the plan), and
 * the locked `StitchPipelineFailureReason` outcomes (`wrong-count`,
 * `duplicate`, `incoherent`).
 */
import { describe, expect, test } from 'vitest';
import { runStitchPipeline } from '../../src/lib/stitch/stitchPipeline';
import { applySourceTransform, assertCoherentProvenance, sealCompositeProvenance } from '../../src/lib/domain/provenance';
import { buildGrayRaster, sceneGray, STEP, TILE_W, TILE_H } from '../helpers/smartMap';
import type { AnalysisRaster, RasterRegion } from '../../src/lib/stitch/analysis';

function fileOf(name: string): File {
	return new File([new Uint8Array(8).fill(1)], name, { type: 'image/png' });
}

function decodedOf(widthPx: number, heightPx: number) {
	return { image: {} as HTMLImageElement, widthPx, heightPx };
}

function buildRotatedRaster(centerX: number, centerY: number, angleDeg: number): AnalysisRaster {
	const widthPx = TILE_W;
	const heightPx = TILE_H;
	const radians = (angleDeg * Math.PI) / 180;
	const cosT = Math.cos(radians);
	const sinT = Math.sin(radians);
	const gray = new Uint8Array(widthPx * heightPx);
	for (let y = 0; y < heightPx; y += 1) {
		for (let x = 0; x < widthPx; x += 1) {
			const ox = x - widthPx / 2;
			const oy = y - heightPx / 2;
			const sx = centerX + ox * cosT - oy * sinT;
			const sy = centerY + ox * sinT + oy * cosT;
			gray[y * widthPx + x] = sceneGray(Math.round(sx), Math.round(sy));
		}
	}
	return { widthPx, heightPx, gray, scale: 1 };
}

let idCounter = 0;
function createSourceId(): string {
	idCounter += 1;
	return `source-${idCounter}`;
}

describe('runStitchPipeline: N=1 (AutoCrop only)', () => {
	test('a single file produces a coherent single-source draft, compositingPolicy single-source-v1', async () => {
		const result = await runStitchPipeline([fileOf('solo.png')], {
			decode: async () => decodedOf(200, 200),
			buildCropRaster: () => buildGrayRaster('upper-left', { chromeTop: 0, chromeBottom: 0 }),
			hash: async () => '1'.repeat(64),
			createSourceId
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.result.draft.compositingPolicy).toBe('single-source-v1');
		expect(result.result.draft.resampling).toBe('none');
		expect(result.result.draft.sources).toHaveLength(1);
		expect(result.result.sources).toHaveLength(1);
		expect(result.result.sources[0].file).toBeInstanceOf(File);

		const provenance = sealCompositeProvenance(result.result.draft, 'f'.repeat(64));
		expect(() => assertCoherentProvenance(provenance)).not.toThrow();
	});
});

describe('runStitchPipeline: N>1 ordinary translation case', () => {
	test('a coherent two-file left-right batch produces a valid DraftComposite passing assertCoherentProvenance', async () => {
		const noChrome = { chromeTop: 0, chromeBottom: 0 };
		const rasters = [
			buildGrayRaster('upper-left', { ...noChrome, origin: { x: 0, y: 0 } }),
			buildGrayRaster('upper-right', { ...noChrome, origin: { x: STEP, y: 0 } })
		];
		let index = 0;
		const result = await runStitchPipeline([fileOf('left.png'), fileOf('right.png')], {
			decode: async () => decodedOf(TILE_W, TILE_H),
			buildRaster: () => rasters[index++ % rasters.length],
			buildCropRaster: () => rasters[index++ % rasters.length],
			hash: async () => '2'.repeat(64),
			createSourceId
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.result.draft.compositingPolicy).toBe('stitch-ascending-bottom-right-v1');
		expect(result.result.draft.resampling).toBe('none');
		expect(result.result.draft.sources).toHaveLength(2);
		expect(result.result.confidence).toBe('auto');

		// paintOrder is a permutation of 0..N-1.
		const orders = result.result.draft.sources.map((s) => s.paintOrder).sort((a, b) => a - b);
		expect(orders).toEqual([0, 1]);

		const provenance = sealCompositeProvenance(result.result.draft, 'f'.repeat(64));
		expect(() => assertCoherentProvenance(provenance)).not.toThrow();
	});
});

describe('runStitchPipeline: rotated N>1 case produces coherent, resampled provenance', () => {
	test('a rotated 3-tile batch produces coveragePolygon/paintOrder that satisfy assertCoherentProvenance, resampling nearest', async () => {
		const tile0 = buildRotatedRaster(150, 150, 0);
		const tile1 = buildRotatedRaster(220, 150, 35);
		const tile2 = buildRotatedRaster(80, 150, 0);
		const rasters = [tile0, tile1, tile2];
		let index = 0;
		const result = await runStitchPipeline(
			[fileOf('a.png'), fileOf('b.png'), fileOf('c.png')],
			{
				decode: async () => decodedOf(TILE_W, TILE_H),
				buildRaster: () => rasters[index++ % rasters.length],
				buildCropRaster: () => rasters[index++ % rasters.length],
				hash: async () => '3'.repeat(64),
				createSourceId,
				applyCropMargin: false
			}
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.result.draft.sources).toHaveLength(3);
		expect(result.result.draft.resampling).toBe('nearest');
		expect(result.result.draft.overlaps.length).toBeGreaterThan(0);

		const models = result.result.draft.sources.map((s) => s.transform.model);
		expect(models).toContain('similarity');
		expect(models).toContain('translation');

		const orders = result.result.draft.sources.map((s) => s.paintOrder).sort((a, b) => a - b);
		expect(orders).toEqual([0, 1, 2]);

		const provenance = sealCompositeProvenance(result.result.draft, 'f'.repeat(64));
		expect(() => assertCoherentProvenance(provenance)).not.toThrow();
	});
});

describe('runStitchPipeline: crop-region matcher offset correction (CHSPT-57 Fix #2)', () => {
	function withChromeBand(raster: AnalysisRaster, chromeTopPx: number, chromeBottomPx: number): AnalysisRaster {
		const gray = new Uint8Array(raster.gray);
		const { widthPx, heightPx } = raster;
		for (let y = 0; y < heightPx; y += 1) {
			for (let x = 0; x < widthPx; x += 1) {
				if (y < chromeTopPx) gray[y * widthPx + x] = 12;
				else if (y >= heightPx - chromeBottomPx) gray[y * widthPx + x] = 30;
			}
		}
		return { widthPx, heightPx, gray, scale: raster.scale };
	}

	function cropToRegion(full: AnalysisRaster, region?: RasterRegion): AnalysisRaster {
		if (!region) return full;
		const { x, y, width, height } = region;
		const gray = new Uint8Array(width * height);
		for (let ry = 0; ry < height; ry += 1) {
			for (let rx = 0; rx < width; rx += 1) {
				gray[ry * width + rx] = full.gray[(y + ry) * full.widthPx + (x + rx)];
			}
		}
		return { widthPx: width, heightPx: height, gray, scale: full.scale };
	}

	test('a shared scene point lands at (nearly) the same composite location whether sampled through tile0 or the rotated, crop-trimmed tile1', async () => {
		// A deep, uniform 20px top / 15px bottom chrome band (identical across
		// both tiles, well past `matcherRegionFromCrop`'s `high`-confidence
		// gate) stacked on the same two-tile rotated scene the "rotated N>1"
		// suite above uses (tile0 unrotated at the scene's own origin, tile1
		// rotated 35deg): this is exactly the shape that made the matcher
		// operate on a REGION-TRIMMED raster while the transform it estimates
		// still has to describe the FULL, untrimmed source raster
		// (`SourceCapture.transform`'s own contract). CHSPT-57 review: without
		// the correction in `stitchPipeline.ts`, that mismatch silently
		// misplaced any tile whose pose escalated past translation, by an
		// amount proportional to the crop offset run through the tile's own
		// rotation matrix — confirmed at ~12px for this exact fixture by
		// temporarily disabling the correction while writing this test.
		const tile0Full = withChromeBand(buildRotatedRaster(150, 150, 0), 20, 15);
		const tile1Full = withChromeBand(buildRotatedRaster(220, 150, 35), 20, 15);
		const fulls = [tile0Full, tile1Full];

		let cropIndex = 0;
		let rasterIndex = 0;
		let hashIndex = 0;
		const result = await runStitchPipeline([fileOf('a.png'), fileOf('b.png')], {
			decode: async () => decodedOf(200, 200),
			buildCropRaster: () => fulls[cropIndex++ % fulls.length],
			buildRaster: (_image, region) => cropToRegion(fulls[rasterIndex++ % fulls.length], region),
			hash: async () => `${hashIndex++}`.padStart(64, '0'),
			createSourceId,
			applyCropMargin: false
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// The chrome band was confidently detected and trimmed from the output,
		// confirming `matcherRegionFromCrop` actually engaged (it requires
		// `high` crop confidence) rather than this test accidentally passing on
		// an untrimmed, no-op crop.
		expect(result.result.draft.sources[0].crop).toEqual({ xPx: 0, yPx: 20, widthPx: 200, heightPx: 165 });
		// Tile1's pose escalated past translation — the case the correction
		// term is not algebraically zero for (a pure translation's linear part
		// is the identity matrix, which makes the correction vanish regardless
		// of the offset; see the derivation in stitchPipeline.ts).
		expect(result.result.draft.sources[1].transform.model).not.toBe('translation');

		// Scene coordinate (150, 150) sits at tile0's exact local (100, 100)
		// (tile0 is centered there with zero rotation, so local == scene - 50).
		// The corresponding point in tile1's own full 200x200 raster — solved
		// by inverting `buildRotatedRaster`'s sampling formula for the same
		// scene coordinate given tile1's center (220, 150) and 35deg rotation,
		// then rounding to the actual sampled pixel exactly as that helper does
		// — is local (43, 140); both are comfortably inside each tile's
		// non-chrome interior ([20, 185) here).
		const sourceA = result.result.draft.sources[0];
		const sourceB = result.result.draft.sources[1];
		const compositeA = applySourceTransform({ xPx: 100, yPx: 100 }, sourceA.transform);
		const compositeB = applySourceTransform({ xPx: 43, yPx: 140 }, sourceB.transform);
		const distancePx = Math.hypot(compositeA.xPx - compositeB.xPx, compositeA.yPx - compositeB.yPx);
		// A correct correction places these within roughly half a pixel here
		// (residual matcher/estimation noise only); the missing correction
		// misplaced tile1 by ~12px on this fixture. 3px keeps meaningful margin
		// on both sides without chasing exact matcher precision.
		expect(distancePx).toBeLessThan(3);
	});
});

describe('runStitchPipeline: locked failure reasons', () => {
	test('zero files is rejected as wrong-count', async () => {
		const result = await runStitchPipeline([]);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.failure.reason).toBe('wrong-count');
	});

	test('two pixel-identical images are rejected as duplicate, with indices into the caller file list', async () => {
		const noChrome = { chromeTop: 0, chromeBottom: 0 };
		const raster = buildGrayRaster('upper-left', noChrome);
		let index = 0;
		const result = await runStitchPipeline([fileOf('a.png'), fileOf('b.png')], {
			decode: async () => decodedOf(TILE_W, TILE_H),
			buildRaster: () => raster,
			buildCropRaster: () => raster,
			hash: async () => `${index++}`.padStart(64, '0'),
			createSourceId
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.failure.reason).toBe('duplicate');
		expect(result.failure.duplicate).toEqual({ firstIndex: 0, duplicateIndex: 1 });
	});

	test('a genuinely unrelated capture is rejected as incoherent rather than forcing a placement', async () => {
		const noChrome = { chromeTop: 0, chromeBottom: 0 };
		const rasters = [
			buildGrayRaster('upper-left', { ...noChrome, origin: { x: 0, y: 0 } }),
			buildGrayRaster('upper-right', { ...noChrome, origin: { x: STEP, y: 0 } }),
			buildGrayRaster('lower-left', { ...noChrome, unrelated: true })
		];
		let index = 0;
		const result = await runStitchPipeline(
			[fileOf('a.png'), fileOf('b.png'), fileOf('c.png')],
			{
				decode: async () => decodedOf(TILE_W, TILE_H),
				buildRaster: () => rasters[index++ % rasters.length],
				buildCropRaster: () => rasters[index++ % rasters.length],
				hash: async () => `${index}`.padStart(64, '0'),
				createSourceId
			}
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.failure.reason).toBe('incoherent');
	});
});
