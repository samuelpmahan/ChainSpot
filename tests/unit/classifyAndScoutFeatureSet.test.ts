import { describe, expect, test } from 'vitest';
import {
	compileABFeatureSet,
	createExecBoard,
	executeABFeatureSet,
	type ABFeatureSet
} from '@chainspot/alg/exec';
import { nullFeatureContext } from '@chainspot/alg/detectors/threeFactor/features/types';
import { classifyAndScoutFeature } from '$lib/classifyAndScout.feature';
import type { ScoutThumbnailTrace } from '$lib/scoutThumbnails.types';

const rejectedThumbnail: ScoutThumbnailTrace = {
	runId: 'run-1',
	imageId: 'image-1',
	paramsHash: 'thumbnail-params',
	featureId: 'scout-thumbnails',
	traceHash: 'thumbnail-trace-1',
	objectIds: { source: 'image-1' },
	source: { widthPx: 'UNKNOWN', heightPx: 'UNKNOWN' },
	decoder: 'UNKNOWN',
	resampler: 'UNKNOWN',
	timingsMs: { decode: 0, resize: 0, total: 0 },
	verdict: 'rejected',
	reason: 'test-no-browser-bitmap'
};

describe('classify-and-scout ABFeatureSet integration', () => {
	test('executes the real feature operation and reports truthful slot custody', async () => {
		const definition: ABFeatureSet = {
			id: 'tick4-integration',
			seededSlots: ['thumbnail', 'classifyAndScout.options'],
			features: [classifyAndScoutFeature]
		};
		const compiled = compileABFeatureSet(definition, {
			'classify-and-scout': { enabled: true }
		});
		const board = createExecBoard();
		board.set('thumbnail', [rejectedThumbnail]);
		board.set('classifyAndScout.options', { runId: 'run-1', paramsHash: 'classify-params' });

		const receipt = await executeABFeatureSet(compiled, board, nullFeatureContext, {
			runId: 'run-1',
			invocation: 'vitest classifyAndScoutFeatureSet'
		});

		expect(
			board.get<readonly { classification: string; reason?: string }[]>('classifyAndScout.trace')
		).toMatchObject([{ classification: 'unknown', reason: 'thumbnail-pixels-unavailable' }]);
		expect(receipt.operations).toMatchObject([
			{
				opId: 'classifyAndScout.dispatch',
				declaredConsumes: ['thumbnail', 'classifyAndScout.options'],
				actualConsumes: ['thumbnail', 'classifyAndScout.options'],
				declaredProduces: ['classifyAndScout.trace', 'classifyAndScout.evidence'],
				actualProduces: ['classifyAndScout.trace', 'classifyAndScout.evidence']
			}
		]);
		expect(
			board.get<readonly { cliText: string }[]>('classifyAndScout.evidence')[0].cliText
		).toContain('thumbnail-pixels-unavailable');
		expect(receipt.operations[0].artifacts).toMatchObject([
			{
				id: 'classify-and-scout.semantic-trace',
				kind: 'measurementTable'
			}
		]);
		expect(receipt.operations[0].artifacts[0].sha256).toMatch(/^[0-9a-f]{64}$/);
	});
});
