import { describe, expect, test } from 'vitest';
import {
	compileABFeatureSet,
	createExecBoard,
	executeABFeatureSet,
	type ABFeatureSet
} from '@chainspot/alg/exec';
import { nullFeatureContext } from '@chainspot/alg/detectors/threeFactor/features/types';
import { selectiveFullDecodeFeature } from '$lib/selectiveFullDecode.feature';
import type { ClassifyAndScoutTrace } from '$lib/classifyAndScout.types';

const upstream: ClassifyAndScoutTrace = {
	runId: 'run-5',
	imageId: 'image-5',
	paramsHash: 'classify-5',
	featureId: 'classify-and-scout',
	traceHash: 'upstream-5',
	thumbnailTraceHash: 'thumbnail-5',
	objectIds: { source: 'source-5', classification: 'classification-5' },
	source: { widthPx: 1000, heightPx: 500 },
	thumbnail: { widthPx: 256, heightPx: 128 },
	transform: {
		sourceToThumbnail: { sx: 0.256, sy: 0.256 },
		thumbnailToSource: { sx: 1000 / 256, sy: 500 / 128 }
	},
	classification: 'thrown',
	thumbnailBitmap: undefined,
	regions: [
		{
			imageId: 'image-5',
			regionId: 'region-5',
			kind: 'purple-mass',
			verdict: 'candidate',
			thumbnailRect: { leftPx: 1, topPx: 2, rightPx: 8, bottomPx: 9 },
			sourceRect: { leftPx: 10.25, topPx: 20.5, rightPx: 30.75, bottomPx: 40.125 },
			measurements: [{ name: 'area', value: 49, unit: 'px2', provenance: 'classify-and-scout' }],
			reason: 'candidate retained'
		}
	],
	timingsMs: {
		thumbnailPixelRead: 1,
		signalMeasurement: 1,
		classification: 1,
		regionGeneration: 1,
		transform: 1,
		total: 5
	},
	verdict: 'accepted'
};

describe('selective-full-decode ABFeatureSet integration', () => {
	test('exported feature is default OFF and omitted from the compiled plan', () => {
		const definition: ABFeatureSet = {
			id: 'tick5-default-off',
			seededSlots: [],
			features: [selectiveFullDecodeFeature]
		};
		const compiled = compileABFeatureSet(definition);
		expect(compiled.enabledFeatureIds).toEqual([]);
		expect(compiled.plan.ops).toEqual([]);
	});

	test('exported feature runs through the set and preserves an unavailable-source rejection', async () => {
		const definition: ABFeatureSet = {
			id: 'tick5-integration',
			seededSlots: [
				'px.source.capturedSources',
				'classifyAndScout.trace',
				'selectiveFullDecode.options'
			],
			features: [selectiveFullDecodeFeature]
		};
		const compiled = compileABFeatureSet(definition, {
			'selective-full-decode': { enabled: true }
		});
		const board = createExecBoard();
		board.set('px.source.capturedSources', []);
		board.set('classifyAndScout.trace', [upstream]);
		board.set('selectiveFullDecode.options', {
			runId: 'run-5',
			paramsHash: 'params-5',
			featureId: 'selective-full-decode'
		});

		const receipt = await executeABFeatureSet(compiled, board, nullFeatureContext, {
			runId: 'run-5',
			invocation: 'vitest selectiveFullDecodeFeatureSet'
		});
		const traces = board.get<readonly { verdict: string; reason?: string }[]>(
			'selectiveFullDecode.trace'
		);
		expect(traces).toMatchObject([{ verdict: 'rejected', reason: 'unavailable-captured-source' }]);
		expect(
			board.get<readonly { cliText: string }[]>('selectiveFullDecode.evidence')[0].cliText
		).toContain('unavailable-captured-source');
		expect(receipt.enabledFeatureIds).toEqual(['selective-full-decode']);
		expect(receipt.operations).toMatchObject([
			{
				opId: 'selective-full-decode.request',
				declaredConsumes: [
					'px.source.capturedSources',
					'classifyAndScout.trace',
					'selectiveFullDecode.options'
				],
				actualConsumes: [
					'px.source.capturedSources',
					'classifyAndScout.trace',
					'selectiveFullDecode.options'
				],
				declaredProduces: ['selectiveFullDecode.trace', 'selectiveFullDecode.evidence'],
				actualProduces: ['selectiveFullDecode.trace', 'selectiveFullDecode.evidence']
			}
		]);
		expect(receipt.operations[0].artifacts).toHaveLength(1);
		expect(receipt.operations[0].artifacts[0].sha256).toMatch(/^[0-9a-f]{64}$/);
	});
});
