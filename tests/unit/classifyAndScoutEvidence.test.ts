import { describe, expect, test } from 'vitest';
import {
	assertClassifyAndScoutCorrespondence,
	toClassifyAndScoutContactSheet,
	toClassifyAndScoutEvidence
} from '../../src/lib/classifyAndScoutEvidence';
import type { ClassifyAndScoutTrace } from '../../src/lib/classifyAndScout.types';

const base: ClassifyAndScoutTrace = {
	runId: 'run-1', imageId: 'img-1', paramsHash: 'params-1', featureId: 'classify-and-scout',
	traceHash: 'trace-1', thumbnailTraceHash: 'thumb-trace-1',
	objectIds: { source: 'source-1', thumbnail: 'thumb-1', classification: 'class-1' },
	source: { widthPx: 1000, heightPx: 500 }, thumbnail: { widthPx: 256, heightPx: 128 },
	transform: { sourceToThumbnail: { sx: .256, sy: .256 }, thumbnailToSource: { sx: 1000 / 256, sy: 500 / 128 } },
	classification: 'thrown', timingsMs: { thumbnailPixelRead: 1, signalMeasurement: 2, classification: 3, regionGeneration: 4, transform: 5, total: 15 },
	verdict: 'accepted', regions: [
		{ imageId: 'img-1', regionId: 'r-1', kind: 'purple-mass', verdict: 'candidate', thumbnailRect: { leftPx: 1, topPx: 2, rightPx: 8, bottomPx: 9 }, sourceRect: { leftPx: 4, topPx: 8, rightPx: 32, bottomPx: 36 }, measurements: [{ name: 'area', value: 49, unit: 'px2', provenance: 'trace:signal' }], reason: 'candidate retained' },
		{ imageId: 'img-1', regionId: 'r-2', kind: 'purple-mass', verdict: 'rejected', thumbnailRect: 'UNKNOWN', sourceRect: 'UNKNOWN', measurements: [{ name: 'area', value: 'UNKNOWN', unit: 'px2', provenance: 'trace:rejected' }], reason: 'insufficient evidence' }
	]
};

describe('classify-and-scout evidence', () => {
	test('keeps exact one-to-one CLI spatial rows and visual overlays', () => {
		const evidence = toClassifyAndScoutEvidence(base);
		expect(evidence.visualRender.overlays).toHaveLength(2);
		expect(evidence.cliText.match(/^spatial regionId=/gm)).toHaveLength(2);
		expect(evidence.cliText).toContain('regionId=r-1');
		expect(evidence.visualRender.overlays[1]).toMatchObject({ regionId: 'r-2', verdict: 'rejected', thumbnailRect: 'UNKNOWN', classification: 'thrown' });
		expect(evidence.cliText).toContain('thumbnailTraceHash=');
		assertClassifyAndScoutCorrespondence(evidence);
	});

	test('contact sheet retains candidates and rejections, including UNKNOWN', () => {
		const rows = toClassifyAndScoutContactSheet([base]);
		expect(rows.map((row) => [row.regionId, row.verdict])).toEqual([['r-1', 'candidate'], ['r-2', 'rejected']]);
		expect(rows[1].measurements[0].value).toBe('UNKNOWN');
	});

	test('detects a deliberate CLI/visual mismatch', () => {
		const evidence = toClassifyAndScoutEvidence(base);
		const cliText = evidence.cliText
			.split('\n')
			.map((line) => line.startsWith('spatial regionId=') ? line.replace('"traceHash":"trace-1"', '"traceHash":"wrong-trace"') : line)
			.join('\n');
		const mismatched = { ...evidence, cliText };
		expect(() => assertClassifyAndScoutCorrespondence(mismatched)).toThrow(/region 0/);
	});
});
