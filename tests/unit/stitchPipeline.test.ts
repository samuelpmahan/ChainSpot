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
import { assertCoherentProvenance, sealCompositeProvenance } from '../../src/lib/domain/provenance';
import { buildGrayRaster, sceneGray, STEP, TILE_W, TILE_H } from '../helpers/smartMap';
import type { AnalysisRaster } from '../../src/lib/stitch/analysis';

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
