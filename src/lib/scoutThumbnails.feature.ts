import type { OperationArtifact } from '@chainspot/alg/exec';
import type { ABFeature } from '@chainspot/alg/detectors/threeFactor/features/types';

import type { CapturedSource } from './sourceIntake';
import {
	produceScoutThumbnails,
	type ScoutThumbnailOptions,
	type ScoutThumbnailTrace
} from './scoutThumbnails';
import { toScoutThumbnailEvidence, type ScoutThumbnailEvidence } from './scoutThumbnailEvidence';

export type ScoutThumbnailBatchProducer = (
	sources: readonly CapturedSource[],
	options: ScoutThumbnailOptions
) => Promise<readonly ScoutThumbnailTrace[]>;

function scoutTraceArtifact(traces: readonly ScoutThumbnailTrace[]): OperationArtifact {
	const semanticTraces = traces.map((trace) => ({
		runId: trace.runId,
		imageId: trace.imageId,
		paramsHash: trace.paramsHash,
		featureId: trace.featureId,
		traceHash: trace.traceHash,
		objectIds: trace.objectIds,
		source: trace.source,
		thumbnail: trace.thumbnail ?? 'UNKNOWN',
		transform: trace.transform ?? 'UNKNOWN',
		decoder: trace.decoder,
		resampler: trace.resampler,
		verdict: trace.verdict,
		reason: trace.reason ?? null
	}));
	return {
		id: 'scout-thumbnails.trace-metadata',
		kind: 'measurementTable',
		bytes: new TextEncoder().encode(
			JSON.stringify({ featureId: 'scout-thumbnails', traces: semanticTraces })
		)
	};
}

/**
 * Experimental scout representation only. It does not classify images or
 * request a full decode; those remain later features.
 */
export function createScoutThumbnailsFeature(
	produce: ScoutThumbnailBatchProducer = produceScoutThumbnails
): ABFeature {
	return {
		id: 'scout-thumbnails',
		gate: 'shared',
		kind: 'deviation',
		defaultEnabled: false,
		note: 'Produce 256px-max scout thumbnail traces from already captured sources.',
		knobs: {},
		operations: [
			{
				spec: {
					id: 'scout-thumbnails.produce',
					kind: 'materialize',
					gate: 'shared',
					unit: 'scout-thumbnails',
					consumes: ['px.source.capturedSources', 'px.run.scoutThumbnail'],
					produces: ['px.source.thumbnails', 'px.source.thumbnailInspections'],
					calculations: ['fn.produceScoutThumbnails'],
					accessConformance: 'exact',
					features: ['scout-thumbnails'],
					note: 'Await the reviewed thumbnail producer, then derive matching CLItext and VisualRender from its traces.'
				},
				calculationBindings: [{ address: 'fn.produceScoutThumbnails', calculate: produce }],
				async run(board) {
					const sources = board.get<readonly CapturedSource[]>('px.source.capturedSources');
					const options = board.get<ScoutThumbnailOptions>('px.run.scoutThumbnail');
					const traces = await produce(sources, options);
					const evidence: readonly ScoutThumbnailEvidence[] = traces.map(toScoutThumbnailEvidence);
					board.set('px.source.thumbnails', traces);
					board.set('px.source.thumbnailInspections', evidence);
				},
				extractArtifacts(board) {
					return [
						scoutTraceArtifact(board.get<readonly ScoutThumbnailTrace[]>('px.source.thumbnails'))
					];
				}
			}
		]
	};
}

export const scoutThumbnailsFeature = createScoutThumbnailsFeature();
