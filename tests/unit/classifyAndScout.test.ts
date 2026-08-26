import { describe, expect, test } from 'vitest';
import type { RgbaRaster } from '@chainspot/alg/detect';
import {
	classifyAndScoutRaster,
	mapRect,
	produceClassifyAndScouts
} from '../../src/lib/classifyAndScout';

const trace = (id: string) =>
	({
		runId: 'run',
		imageId: id,
		paramsHash: 'params',
		featureId: 'scout-thumbnails',
		traceHash: `thumb-${id}`,
		objectIds: { source: id, thumbnail: `${id}:thumbnail` },
		source: { widthPx: 100, heightPx: 50 },
		thumbnail: { widthPx: 10, heightPx: 5 },
		transform: { sourceToThumbnail: { sx: 0.1, sy: 0.1 }, thumbnailToSource: { sx: 10, sy: 10 } },
		decoder: 'test',
		resampler: 'test',
		timingsMs: { decode: 0, resize: 0, total: 0 },
		verdict: 'accepted'
	}) as const;
const raster = (purple = false): RgbaRaster => ({
	imageId: 'pixels',
	widthPx: 10,
	heightPx: 5,
	rgba: Uint8ClampedArray.from(
		Array.from({ length: 200 }, (_, i) => (i % 4 === 3 ? 255 : purple ? [140, 30, 220][i % 4] : 0))
	)
});
const options = { runId: 'run', paramsHash: 'params', featureId: 'classify-and-scout' } as const;

describe('classify and scout', () => {
	test('maps nonzero half-open bounds to bounded source edges', () =>
		expect(
			mapRect(
				{ leftPx: 1, topPx: 1, rightPx: 10, bottomPx: 5 },
				trace('x').transform,
				trace('x').source
			)
		).toEqual({ leftPx: 10, topPx: 10, rightPx: 100, bottomPx: 50 }));
	test('classifies an obvious purple thumbnail as thrown with a candidate', () =>
		expect(classifyAndScoutRaster(trace('thrown'), options, raster(true), 1)).toMatchObject({
			classification: 'thrown',
			verdict: 'accepted',
			regions: [
				{ verdict: 'candidate', thumbnailRect: { leftPx: 0, topPx: 0, rightPx: 10, bottomPx: 5 } }
			]
		}));
	test('keeps trace identity stable across timing-only changes', () => {
		const fast = classifyAndScoutRaster(trace('stable'), options, raster(true), 1);
		const slow = classifyAndScoutRaster(trace('stable'), options, raster(true), 999);
		expect(slow.timingsMs.thumbnailPixelRead).not.toBe(fast.timingsMs.thumbnailPixelRead);
		expect(slow.traceHash).toBe(fast.traceHash);
	});
	test('retains three all-map inputs in order as rejected, never forced candidates', async () => {
		const result = await produceClassifyAndScouts(
			['a', 'b', 'c'].map(trace),
			options,
			async (item, resolved) => classifyAndScoutRaster(item, resolved, raster(), 0)
		);
		expect(result.map((entry) => entry.imageId)).toEqual(['a', 'b', 'c']);
		expect(
			result.every(
				(entry) =>
					entry.classification === 'unknown' && entry.regions[0].reason === 'no-unique-thrown'
			)
		).toBe(true);
	});
});
