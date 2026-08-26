import { describe, expect, test } from 'vitest';
import {
	assertSelectiveFullDecodeCorrespondence,
	assertSelectiveFullDecodeCorrespondenceRows,
	formatSelectiveFullDecodeAcceptanceReceipt,
	toSelectiveFullDecodeAcceptanceReceipt,
	toSelectiveFullDecodeEvidence
} from '$lib/selectiveFullDecodeEvidence';
import type { SelectiveFullDecodeTrace } from '$lib/selectiveFullDecode.types';

const trace: SelectiveFullDecodeTrace = {
	runId: 'run-5',
	imageId: 'image-5',
	paramsHash: 'params-5',
	featureId: 'selective-full-decode',
	traceHash: 'trace-5',
	upstreamTraceHash: 'upstream-4',
	objectIds: {
		source: 'source-5',
		classification: 'classification-5',
		region: 'region-5',
		crop: 'crop-5'
	},
	requestedSourceRect: { leftPx: 10.25, topPx: 20.5, rightPx: 30.75, bottomPx: 40.125 },
	cropRect: { leftPx: 10, topPx: 20, widthPx: 21, heightPx: 21 },
	geometryProvenance: 'selective-full-decode@1.0.0',
	measurements: [
		{ name: 'cropWidth', value: 21, unit: 'pixels', provenance: 'selective-full-decode@1.0.0' }
	],
	timingsMs: { request: 1, decode: 2, total: 3 },
	verdict: 'accepted'
};

describe('selective full decode evidence', () => {
	test('pairs one CLItext row with one VisualRender model without recomputation', () => {
		const evidence = toSelectiveFullDecodeEvidence(trace);
		expect(evidence.cliText).toMatch(/^selective-full-decode /);
		expect(evidence.cliText).toContain('upstreamTraceHash');
		expect(evidence.visualRender).toMatchObject({
			requestedSourceRect: trace.requestedSourceRect,
			cropRect: trace.cropRect,
			measurements: trace.measurements,
			verdict: 'accepted'
		});
		assertSelectiveFullDecodeCorrespondence(evidence);
		assertSelectiveFullDecodeCorrespondenceRows([evidence]);
	});

	test('retains explicit rejection reasons and detects a CLI/visual mismatch', () => {
		const rejected: SelectiveFullDecodeTrace = {
			...trace,
			traceHash: 'rejected-trace',
			objectIds: { ...trace.objectIds, crop: undefined },
			cropRect: 'UNKNOWN',
			verdict: 'rejected',
			reason: 'unavailable-captured-source'
		};
		const evidence = toSelectiveFullDecodeEvidence(rejected);
		assertSelectiveFullDecodeCorrespondence(evidence);
		const mismatched = {
			...evidence,
			cliText: evidence.cliText.replace('rejected-trace', 'wrong-trace')
		};
		expect(() => assertSelectiveFullDecodeCorrespondence(mismatched)).toThrow(/CLI\/VisualRender/);
	});

	test('formats an acceptance receipt separately from the execution manifest', () => {
		const receipt = toSelectiveFullDecodeAcceptanceReceipt(trace);
		const markdown = formatSelectiveFullDecodeAcceptanceReceipt(receipt);
		expect(markdown).toContain('# Selective Full Decode Acceptance Receipt');
		expect(markdown).toContain('## Receipt identity');
		expect(markdown).toContain('## CLItext');
		expect(markdown).toContain('## VisualRender model');
		expect(markdown).toContain('## Implementer math');
		expect(markdown).toContain('floor(requested.leftPx)');
		expect(markdown).toContain('ceil(requested.rightPx)');
		expect(markdown).toContain('## Reviewer verification');
		expect(markdown).toContain('**PENDING**');
		expect(receipt.fullDetailHash).toMatch(/^[0-9a-f]{64}$/);
		expect(markdown).toContain(receipt.fullDetailHash);
	});
});
