import { describe, expect, test } from 'vitest';
import type { CapturedSource } from '../../src/lib/sourceIntake';
import type { ClassifyAndScoutTrace, ScoutRectPx } from '../../src/lib/classifyAndScout.types';
import {
	integerCropRect,
	produceSelectiveFullDecode,
	SELECTIVE_FULL_DECODE_REASONS
} from '../../src/lib/selectiveFullDecode';

const file = { name: 'map.png' } as File;
const source = (imageId = 'image-1'): CapturedSource => ({
	file,
	selectionIndex: 0,
	imageId,
	sourceByteLength: 100,
	readMs: 0,
	hashMs: 0
});
const rect = (overrides: Partial<ScoutRectPx> = {}): ScoutRectPx => ({
	leftPx: 10.2,
	topPx: 20.8,
	rightPx: 30.1,
	bottomPx: 40.9,
	...overrides
});
const trace = (
	imageId = 'image-1',
	regionOverrides: Partial<{
		sourceRect: ScoutRectPx | 'UNKNOWN';
		verdict: 'candidate' | 'rejected';
	}> = {},
	traceOverrides: Partial<ClassifyAndScoutTrace> = {}
): ClassifyAndScoutTrace => ({
	runId: 'run',
	imageId,
	paramsHash: 'params',
	featureId: 'classify-and-scout',
	traceHash: `upstream-${imageId}`,
	thumbnailTraceHash: `thumb-${imageId}`,
	objectIds: { source: imageId, classification: `${imageId}:classification` },
	source: { widthPx: 100, heightPx: 100 },
	thumbnail: { widthPx: 10, heightPx: 10 },
	transform: { sourceToThumbnail: { sx: 0.1, sy: 0.1 }, thumbnailToSource: { sx: 10, sy: 10 } },
	classification: 'thrown',
	regions: [
		{
			regionId: `${imageId}:region-0`,
			imageId,
			kind: 'purple-mass',
			verdict: 'candidate',
			thumbnailRect: rect(),
			sourceRect: rect(),
			measurements: [],
			reason: 'purple-mass-bounds',
			...regionOverrides
		}
	],
	timingsMs: {
		thumbnailPixelRead: 0,
		signalMeasurement: 0,
		classification: 0,
		regionGeneration: 0,
		transform: 0,
		total: 0
	},
	verdict: 'accepted',
	...traceOverrides
});
const options = { runId: 'run', paramsHash: 'params' } as const;
const fakeBitmap = { width: 20, height: 20 } as ImageBitmap;

describe('selective full decode', () => {
	test('uses floor/ceil half-open crop math and clamps numeric dimensions', () => {
		expect(integerCropRect(rect(), { widthPx: 25, heightPx: 35 })).toEqual({
			leftPx: 10,
			topPx: 20,
			widthPx: 15,
			heightPx: 15
		});
		expect(
			integerCropRect(rect({ leftPx: -4.2, topPx: -2.1, rightPx: 4.2, bottomPx: 3.1 }), {
				widthPx: 100,
				heightPx: 100
			})
		).toEqual({ leftPx: 0, topPx: 0, widthPx: 5, heightPx: 4 });
		expect(
			integerCropRect(rect({ leftPx: 9, rightPx: 9.1 }), { widthPx: 100, heightPx: 100 })
		).toEqual({ leftPx: 9, topPx: 20, widthPx: 1, heightPx: 21 });
		expect(
			integerCropRect(rect({ leftPx: 100, rightPx: 100.1 }), { widthPx: 100, heightPx: 100 })
		).toBeUndefined();
	});

	test('decodes only required candidate rows with the exact integer crop', async () => {
		const calls: number[][] = [];
		const result = await produceSelectiveFullDecode(
			[source()],
			[trace()],
			options,
			async (_file, left, top, width, height) => {
				calls.push([left, top, width, height]);
				return fakeBitmap;
			}
		);
		expect(calls).toEqual([[10, 20, 21, 21]]);
		expect(result.traces[0]).toMatchObject({
			verdict: 'accepted',
			cropRect: { leftPx: 10, topPx: 20, widthPx: 21, heightPx: 21 },
			bitmap: fakeBitmap
		});
		expect(result.traces[0].geometryProvenance).toContain('floor(left/top)');
	});

	test('requires an accepted thrown classification before decoding a candidate region', async () => {
		let decodeCalls = 0;
		const mapCandidate = trace('map-candidate', {}, { classification: 'map' });
		const result = await produceSelectiveFullDecode(
			[source('map-candidate')],
			[mapCandidate],
			options,
			async () => {
				decodeCalls += 1;
				return fakeBitmap;
			}
		);
		expect(decodeCalls).toBe(0);
		expect(result.traces).toMatchObject([
			{ verdict: 'rejected', reason: SELECTIVE_FULL_DECODE_REASONS.UPSTREAM_REJECTED }
		]);
	});

	test('rejects candidate crops when source dimensions are unknown or invalid', async () => {
		const cases: Array<{
			imageId: string;
			source: { widthPx: number | 'UNKNOWN'; heightPx: number | 'UNKNOWN' };
			reason: string;
		}> = [
			{
				imageId: 'unknown-dimensions',
				source: { widthPx: 'UNKNOWN', heightPx: 100 },
				reason: SELECTIVE_FULL_DECODE_REASONS.UNKNOWN_SOURCE_DIMENSIONS
			},
			{
				imageId: 'zero-width',
				source: { widthPx: 0, heightPx: 100 },
				reason: SELECTIVE_FULL_DECODE_REASONS.INVALID_SOURCE_DIMENSIONS
			},
			{
				imageId: 'nan-width',
				source: { widthPx: Number.NaN, heightPx: 100 },
				reason: SELECTIVE_FULL_DECODE_REASONS.INVALID_SOURCE_DIMENSIONS
			},
			{
				imageId: 'negative-height',
				source: { widthPx: 100, heightPx: -1 },
				reason: SELECTIVE_FULL_DECODE_REASONS.INVALID_SOURCE_DIMENSIONS
			}
		];
		let decodeCalls = 0;
		const result = await produceSelectiveFullDecode(
			cases.map(({ imageId }) => source(imageId)),
			cases.map(({ imageId, source: dimensions }) => trace(imageId, {}, { source: dimensions })),
			options,
			async () => {
				decodeCalls += 1;
				return fakeBitmap;
			}
		);
		expect(decodeCalls).toBe(0);
		expect(result.traces.map((item) => item.reason)).toEqual(cases.map(({ reason }) => reason));
	});

	test('emits one rejection for every non-decodable row', async () => {
		const rows = [
			trace('missing'),
			trace('image-1', { sourceRect: 'UNKNOWN' }),
			trace('image-2', { sourceRect: rect({ leftPx: Number.NaN }) }),
			trace('image-3', { sourceRect: rect({ leftPx: 50, rightPx: 50 }) }),
			trace('image-4', { verdict: 'rejected' }),
			trace('image-5')
		];
		const result = await produceSelectiveFullDecode(
			[
				source('image-1'),
				source('image-2'),
				source('image-3'),
				source('image-4'),
				source('image-5')
			],
			rows,
			options,
			async () => {
				throw new Error('decoder exploded');
			}
		);
		expect(result.traces).toHaveLength(rows.length);
		expect(result.traces.map((item) => item.reason)).toEqual([
			SELECTIVE_FULL_DECODE_REASONS.UNAVAILABLE_SOURCE,
			SELECTIVE_FULL_DECODE_REASONS.UNKNOWN_RECT,
			SELECTIVE_FULL_DECODE_REASONS.INVALID_BOUNDS,
			SELECTIVE_FULL_DECODE_REASONS.EMPTY_RECT,
			SELECTIVE_FULL_DECODE_REASONS.UPSTREAM_REJECTED,
			SELECTIVE_FULL_DECODE_REASONS.DECODE_FAILURE
		]);
	});

	test('does not silently drop traces with no regions', async () => {
		const empty = trace('empty', {}, { regions: [] });
		const result = await produceSelectiveFullDecode(
			[source('empty')],
			[empty],
			options,
			async () => fakeBitmap
		);
		expect(result.traces).toHaveLength(1);
		expect(result.traces[0]).toMatchObject({
			verdict: 'rejected',
			reason: SELECTIVE_FULL_DECODE_REASONS.UPSTREAM_REJECTED,
			requestedSourceRect: 'UNKNOWN'
		});
	});

	test('keeps semantic trace identity stable when timings change', async () => {
		const first = await produceSelectiveFullDecode(
			[source()],
			[trace()],
			options,
			async () => fakeBitmap
		);
		const second = await produceSelectiveFullDecode(
			[source()],
			[trace()],
			options,
			async () => fakeBitmap
		);
		expect(first.traces[0].traceHash).toBe(second.traces[0].traceHash);
		expect(first.traces[0].timingsMs).toHaveProperty('decode');
		expect(second.traces[0].timingsMs).toHaveProperty('total');
	});
});
