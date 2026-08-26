import { describe, expect, test } from 'vitest';
import {
	assertScoutThumbnailCorrespondence,
	toScoutThumbnailContactSheet,
	toScoutThumbnailEvidence,
	type ScoutEvidenceTrace
} from '../../src/lib/scoutThumbnailEvidence';

const accepted: ScoutEvidenceTrace = {
	runId: 'run-1', imageId: 'img-1', paramsHash: 'params-1', featureId: 'scout-thumbnails', traceHash: 'trace-1',
	objectIds: { source: 'img-1', thumbnail: 'img-1:thumbnail' },
	source: { widthPx: 1000, heightPx: 500 }, thumbnail: { widthPx: 256, heightPx: 128 },
	transform: { sourceToThumbnail: { sx: .256, sy: .256 }, thumbnailToSource: { sx: 1000 / 256, sy: 500 / 128 } },
	decoder: 'createImageBitmap', resampler: 'createImageBitmap.resizeQuality=high',
	timingsMs: { decode: 2, resize: 3, total: 5 }, verdict: 'accepted'
};

describe('scout thumbnail evidence', () => {
	test('pairs CLItext and VisualRender from the same trace', () => {
		const evidence = toScoutThumbnailEvidence(accepted);
		expect(evidence.visualRender).toMatchObject({ runId: 'run-1', imageId: 'img-1', traceHash: 'trace-1' });
		expect(() => assertScoutThumbnailCorrespondence(evidence.cliText, evidence.visualRender)).not.toThrow();
	});

	test('contact sheet preserves one row per trace without recomputation', () => {
		const rejected: ScoutEvidenceTrace = { ...accepted, imageId: 'img-2', traceHash: 'trace-2', objectIds: { source: 'img-2' }, source: { widthPx: 'UNKNOWN', heightPx: 'UNKNOWN' }, thumbnail: undefined, verdict: 'rejected', reason: 'browser decoder unavailable', decoder: 'UNKNOWN', resampler: 'UNKNOWN' };
		expect(toScoutThumbnailContactSheet([accepted, rejected])).toEqual([
		toScoutThumbnailEvidence(accepted).visualRender,
		toScoutThumbnailEvidence(rejected).visualRender
		]);
	});

	test('detects mismatched and rejection evidence', () => {
		const evidence = toScoutThumbnailEvidence(accepted);
		expect(() => assertScoutThumbnailCorrespondence(evidence.cliText.replace('trace-1', 'wrong'), evidence.visualRender)).toThrow(/traceHash/);
		const rejected = toScoutThumbnailEvidence({ ...accepted, verdict: 'rejected', reason: 'bad bytes' });
		expect(rejected.cliText).toContain('verdict=rejected');
		expect(rejected.cliText).toContain('reason=bad bytes');
	});
});
