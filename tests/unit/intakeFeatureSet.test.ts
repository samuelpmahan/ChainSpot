import { describe, expect, test } from 'vitest';
import { runIntakeFeatureSet } from '$lib/intakeFeatureSet';

function sourceFile(name: string, bytes: readonly number[]): File {
	return {
		name,
		arrayBuffer: async () => Uint8Array.from(bytes).buffer
	} as File;
}

describe('intake ABFeatureSet', () => {
	test('runs Ticks 1-5 in order and preserves unavailable decoders as evidence', async () => {
		const result = await runIntakeFeatureSet({
			selectedFiles: [sourceFile('map.png', [1, 2, 3, 4])],
			runId: 'intake-set-test',
			invocation: 'vitest intake ABFeatureSet',
			scoutParamsHash: 'scout-params',
			classifyParamsHash: 'classify-params',
			scoutEnabled: true
		});

		expect(result.captureReceipt.entries).toMatchObject([
			{ ok: true, source: { selectionIndex: 0, sourceByteLength: 4 } }
		]);
		expect(result.thumbnailTraces).toMatchObject([
			{ verdict: 'rejected', reason: 'browser decoder unavailable' }
		]);
		expect(result.classificationTraces).toMatchObject([
			{ verdict: 'rejected', classification: 'unknown', reason: 'thumbnail-pixels-unavailable' }
		]);
		expect(result.selectiveFullDecodeTraces).toMatchObject([
			{ verdict: 'rejected', reason: 'upstream-rejected-or-non-required-region' }
		]);

		expect(result.setManifest.enabledFeatureIds).toEqual([
			'capture-source-files',
			'scout-thumbnails',
			'classify-and-scout',
			'selective-full-decode'
		]);
		expect(result.setManifest.operations.map((operation) => operation.opId)).toEqual([
			'capture-source-files.capture',
			'scout-thumbnails.produce',
			'classifyAndScout.dispatch',
			'selective-full-decode.request'
		]);
		for (const operation of result.setManifest.operations) {
			expect(operation.actualConsumes).toEqual(operation.declaredConsumes);
			expect(operation.actualProduces).toEqual(operation.declaredProduces);
			expect(operation.artifacts).toHaveLength(1);
			expect(operation.artifacts[0].sha256).toMatch(/^[0-9a-f]{64}$/);
		}
		expect(result.acceptanceReceiptMarkdown).toContain('# Intake Acceptance Receipt');
		expect(result.acceptanceReceiptMarkdown).toContain('### Measurement / math description');
		expect(result.acceptanceReceiptMarkdown).toContain('### VisualRender model');
		expect(result.acceptanceReceiptMarkdown).toContain('### CLI text');
		expect(result.acceptanceReceiptMarkdown).toContain('## Selective full decode 1:');
		expect(result.acceptanceReceiptMarkdown).toContain(
			'classification=thrown, upstream verdict=accepted, and region verdict=candidate'
		);
		expect(result.acceptanceReceiptMarkdown).toContain('- reviewer verification: **PASS**');
		expect(result.acceptanceReceiptMarkdown).toContain(result.acceptanceReceiptHash);
		expect(result.acceptanceReceiptHash).toMatch(/^[0-9a-f]{64}$/);
	});
});
