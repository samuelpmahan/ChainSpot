import type { ABFeature } from '@chainspot/alg/detectors/threeFactor/features/types';
import type { ABFeatureOperation } from '@chainspot/alg/exec/feature-set';
import type { ScoutThumbnailTrace } from './scoutThumbnails.types';
import {
	CLASSIFY_AND_SCOUT_FEATURE_ID,
	type ClassifyAndScoutOptions
} from './classifyAndScout.types';
import { produceClassifyAndScouts } from './classifyAndScout';
import { toClassifyAndScoutEvidence } from './classifyAndScoutEvidence';

export const classifyAndScoutFeature = {
	id: CLASSIFY_AND_SCOUT_FEATURE_ID,
	gate: 'shared',
	kind: 'deviation',
	defaultEnabled: false,
	note: 'Thumbnail-only purple-mass classification and region scout.',
	knobs: {},
	operations: [
		{
			spec: {
				id: 'classifyAndScout.dispatch',
				kind: 'compute',
				gate: 'shared',
				unit: CLASSIFY_AND_SCOUT_FEATURE_ID,
				consumes: ['thumbnail', 'classifyAndScout.options'],
				produces: ['classifyAndScout.trace', 'classifyAndScout.evidence'],
				calculations: ['fn.produceClassifyAndScouts'],
				features: [CLASSIFY_AND_SCOUT_FEATURE_ID]
			},
			calculationBindings: [
				{ address: 'fn.produceClassifyAndScouts', calculate: produceClassifyAndScouts }
			],
			async run(board) {
				const traces = board.get<readonly ScoutThumbnailTrace[]>('thumbnail');
				const options = board.get<ClassifyAndScoutOptions>('classifyAndScout.options');
				const results = await produceClassifyAndScouts(traces, options);
				board.set('classifyAndScout.trace', results);
				board.set('classifyAndScout.evidence', results.map(toClassifyAndScoutEvidence));
			},
			extractArtifacts(board) {
				const traces = board.get<
					readonly {
						imageId: string;
						paramsHash: string;
						featureId: string;
						thumbnailTraceHash: string;
						classification: string;
						regions: unknown;
						verdict: string;
						reason?: string;
					}[]
				>('classifyAndScout.trace');
				const semantic = traces.map((trace) => ({
					imageId: trace.imageId,
					paramsHash: trace.paramsHash,
					featureId: trace.featureId,
					thumbnailTraceHash: trace.thumbnailTraceHash,
					classification: trace.classification,
					regions: trace.regions,
					verdict: trace.verdict,
					reason: trace.reason
				}));
				return [
					{
						kind: 'measurementTable',
						id: 'classify-and-scout.semantic-trace',
						bytes: new TextEncoder().encode(JSON.stringify(semantic))
					}
				];
			}
		}
	] as readonly ABFeatureOperation[]
} satisfies ABFeature;

export const classifyAndScoutOperations = classifyAndScoutFeature.operations.map(
	(operation) => operation.spec
);
