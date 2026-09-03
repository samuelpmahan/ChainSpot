import type { ABFeature } from '@chainspot/alg/detectors/threeFactor/features/types';
import type { OperationArtifact } from '@chainspot/alg/exec';
import type { CapturedSource } from './sourceIntake';
import { produceSelectiveFullDecode } from './selectiveFullDecode';
import type { ClassifyAndScoutTrace } from './classifyAndScout.types';
import {
	SELECTIVE_FULL_DECODE_FEATURE_ID,
	type SelectiveFullDecodeBatch,
	type SelectiveFullDecodeOptions,
	type SelectiveFullDecodeTrace
} from './selectiveFullDecode.types';
import { toSelectiveFullDecodeEvidence } from './selectiveFullDecodeEvidence';

function traceArtifact(traces: readonly SelectiveFullDecodeTrace[]): OperationArtifact {
	const semantic = traces.map((trace) => ({
		runId: trace.runId,
		imageId: trace.imageId,
		paramsHash: trace.paramsHash,
		featureId: trace.featureId,
		traceHash: trace.traceHash,
		upstreamTraceHash: trace.upstreamTraceHash,
		objectIds: trace.objectIds,
		requestedSourceRect: trace.requestedSourceRect,
		cropRect: trace.cropRect,
		geometryProvenance: trace.geometryProvenance,
		measurements: trace.measurements,
		verdict: trace.verdict,
		reason: trace.reason ?? null
	}));
	return {
		id: 'selective-full-decode.trace-metadata',
		kind: 'measurementTable',
		bytes: new TextEncoder().encode(
			JSON.stringify({ featureId: SELECTIVE_FULL_DECODE_FEATURE_ID, traces: semantic })
		)
	};
}

export type SelectiveFullDecodeBatchProducer = (
	sources: readonly CapturedSource[],
	traces: readonly ClassifyAndScoutTrace[],
	options: Required<SelectiveFullDecodeOptions>
) => Promise<SelectiveFullDecodeBatch>;

export function createSelectiveFullDecodeFeature(
	produce: SelectiveFullDecodeBatchProducer = produceSelectiveFullDecode
): ABFeature {
	return {
		id: SELECTIVE_FULL_DECODE_FEATURE_ID,
		gate: 'shared',
		kind: 'deviation',
		defaultEnabled: false,
		note: 'Decode full-resolution pixels only for classified scout regions.',
		knobs: {},
		operations: [
			{
				spec: {
					id: 'selective-full-decode.request',
					kind: 'materialize',
					gate: 'shared',
					unit: SELECTIVE_FULL_DECODE_FEATURE_ID,
					consumes: [
						'px.source.capturedSources',
						'classifyAndScout.trace',
						'selectiveFullDecode.options'
					],
					produces: ['selectiveFullDecode.trace', 'selectiveFullDecode.evidence'],
					calculations: ['fn.produceSelectiveFullDecode'],
					features: [SELECTIVE_FULL_DECODE_FEATURE_ID],
					note: 'Request only source rectangles named by upstream classification traces.'
				},
				calculationBindings: [{ address: 'fn.produceSelectiveFullDecode', calculate: produce }],
				async run(board) {
					const sources = board.get<readonly CapturedSource[]>('px.source.capturedSources');
					const classifications =
						board.get<readonly ClassifyAndScoutTrace[]>('classifyAndScout.trace');
					const options = board.get<Required<SelectiveFullDecodeOptions>>(
						'selectiveFullDecode.options'
					);
					const batch = await produce(sources, classifications, options);
					board.set('selectiveFullDecode.trace', batch.traces);
					board.set(
						'selectiveFullDecode.evidence',
						batch.traces.map(toSelectiveFullDecodeEvidence)
					);
				},
				extractArtifacts(board) {
					return [
						traceArtifact(
							board.get<readonly SelectiveFullDecodeTrace[]>('selectiveFullDecode.trace')
						)
					];
				}
			}
		]
	};
}

export const selectiveFullDecodeFeature = createSelectiveFullDecodeFeature();
