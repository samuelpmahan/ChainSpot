import { describe, expect, test } from 'vitest';
import {
	produceScoutThumbnail,
	scoutThumbnailTransform,
	produceScoutThumbnails
} from '../../src/lib/scoutThumbnails';

describe('scout thumbnails', () => {
	test('uses pixel-center scales in both directions', () => {
		expect(scoutThumbnailTransform(1000, 500, 256, 128)).toEqual({
			sourceToThumbnail: { sx: 0.256, sy: 0.256 },
			thumbnailToSource: { sx: 1000 / 256, sy: 500 / 128 }
		});
		const xThumbnail = (999 + 0.5) * (256 / 1000) - 0.5;
		const xSource = (xThumbnail + 0.5) * (1000 / 256) - 0.5;
		expect(xSource).toBeCloseTo(999);
	});

	test('dispatches accepted traces and preserves rejected reasons', async () => {
		const source = {
			file: {} as File,
			imageId: 'abc',
			selectionIndex: 0,
			sourceByteLength: 3,
			readMs: 1,
			hashMs: 1
		};
		const traces = await produceScoutThumbnails(
			[source],
			{ runId: 'r', paramsHash: 'p' },
			async (_source, options) => ({
				runId: options.runId,
				imageId: 'abc',
				paramsHash: options.paramsHash,
				featureId: options.featureId,
				traceHash: 't',
				objectIds: { source: 'abc' },
				source: { widthPx: 'UNKNOWN', heightPx: 'UNKNOWN' },
				decoder: 'UNKNOWN',
				resampler: 'UNKNOWN',
				timingsMs: { decode: 0, resize: 0, total: 0 },
				verdict: 'rejected',
				reason: 'browser decoder unavailable'
			})
		);
		expect(traces[0].verdict).toBe('rejected');
		expect(traces[0].reason).toBe('browser decoder unavailable');
	});

	test('excludes elapsed timing from rejected trace identity', async () => {
		const source = {
			file: {} as File,
			imageId: 'abc',
			selectionIndex: 0,
			sourceByteLength: 3,
			readMs: 1,
			hashMs: 1
		};
		const options = {
			runId: 'r',
			paramsHash: 'p',
			featureId: 'scout-thumbnails',
			maxSidePx: 256
		};
		const first = await produceScoutThumbnail(source, options);
		const second = await produceScoutThumbnail(source, options);

		expect(first.verdict).toBe('rejected');
		expect(second.verdict).toBe('rejected');
		expect(first.traceHash).toBe(second.traceHash);
	});
});
