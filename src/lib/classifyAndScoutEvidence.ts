import type {
	ClassifyAndScoutTrace,
	ScoutMeasurement,
	ScoutRectPx,
	ScoutRegion
} from './classifyAndScout.types';
import { describePurpleMassMath } from '@chainspot/alg/detectors/purpleMass';

/** Evidence projection only: this module never reads pixels or runs CV. */
export interface ClassifyAndScoutVisualRegion {
	readonly runId: string;
	readonly imageId: string;
	readonly paramsHash: string;
	readonly featureId: string;
	readonly traceHash: string;
	readonly thumbnailTraceHash: string;
	readonly sourceObjectId: string;
	readonly thumbnailObjectId: string;
	readonly classificationObjectId: string;
	readonly regionId: string;
	readonly classification: ClassifyAndScoutTrace['classification'];
	readonly kind: ScoutRegion['kind'];
	readonly verdict: ScoutRegion['verdict'];
	readonly thumbnailRect: ScoutRectPx | 'UNKNOWN';
	readonly sourceRect: ScoutRectPx | 'UNKNOWN';
	readonly measurements: readonly ScoutMeasurement[];
	readonly reason: string;
	readonly source: ClassifyAndScoutTrace['source'];
	readonly thumbnail: ClassifyAndScoutTrace['thumbnail'] | 'UNKNOWN';
	readonly transform: ClassifyAndScoutTrace['transform'];
	readonly timingsMs: ClassifyAndScoutTrace['timingsMs'];
}

export interface ClassifyAndScoutEvidence {
	readonly mathText: string;
	readonly cliText: string;
	readonly visualRender: {
		readonly receipt: Omit<
			ClassifyAndScoutVisualRegion,
			'regionId' | 'kind' | 'verdict' | 'thumbnailRect' | 'sourceRect' | 'measurements' | 'reason'
		> & {
			readonly verdict: ClassifyAndScoutTrace['verdict'];
			readonly reason?: string;
		};
		readonly overlays: readonly ClassifyAndScoutVisualRegion[];
	};
}

function visualRegion(
	trace: ClassifyAndScoutTrace,
	region: ScoutRegion
): ClassifyAndScoutVisualRegion {
	return {
		runId: trace.runId,
		imageId: trace.imageId,
		paramsHash: trace.paramsHash,
		featureId: trace.featureId,
		traceHash: trace.traceHash,
		thumbnailTraceHash: trace.thumbnailTraceHash,
		sourceObjectId: trace.objectIds.source,
		thumbnailObjectId: trace.objectIds.thumbnail ?? 'UNKNOWN',
		classificationObjectId: trace.objectIds.classification,
		regionId: region.regionId,
		classification: trace.classification,
		kind: region.kind,
		verdict: region.verdict,
		thumbnailRect: region.thumbnailRect,
		sourceRect: region.sourceRect,
		measurements: region.measurements,
		reason: region.reason,
		source: trace.source,
		thumbnail: trace.thumbnail ?? 'UNKNOWN',
		transform: trace.transform,
		timingsMs: trace.timingsMs
	};
}

function receipt(
	trace: ClassifyAndScoutTrace
): ClassifyAndScoutEvidence['visualRender']['receipt'] {
	return {
		runId: trace.runId,
		imageId: trace.imageId,
		paramsHash: trace.paramsHash,
		featureId: trace.featureId,
		traceHash: trace.traceHash,
		thumbnailTraceHash: trace.thumbnailTraceHash,
		sourceObjectId: trace.objectIds.source,
		thumbnailObjectId: trace.objectIds.thumbnail ?? 'UNKNOWN',
		classificationObjectId: trace.objectIds.classification,
		classification: trace.classification,
		source: trace.source,
		thumbnail: trace.thumbnail ?? 'UNKNOWN',
		transform: trace.transform,
		timingsMs: trace.timingsMs,
		verdict: trace.verdict,
		reason: trace.reason
	};
}

function cliText(
	trace: ClassifyAndScoutTrace,
	overlays: readonly ClassifyAndScoutVisualRegion[]
): string {
	const lines = [`classify-and-scout receipt=${JSON.stringify(receipt(trace))}`];
	for (const overlay of overlays) {
		lines.push(
			`spatial regionId=${overlay.regionId} runId=${overlay.runId} imageId=${overlay.imageId} paramsHash=${overlay.paramsHash} featureId=${overlay.featureId} traceHash=${overlay.traceHash} thumbnailTraceHash=${overlay.thumbnailTraceHash} classification=${overlay.classification} verdict=${overlay.verdict} data=${JSON.stringify(overlay)}`
		);
	}
	return lines.join('\n');
}

export function toClassifyAndScoutEvidence(trace: ClassifyAndScoutTrace): ClassifyAndScoutEvidence {
	const overlays = trace.regions.map((region) => visualRegion(trace, region));
	return {
		mathText: describePurpleMassMath(),
		cliText: cliText(trace, overlays),
		visualRender: { receipt: receipt(trace), overlays }
	};
}

export function toClassifyAndScoutContactSheet(
	traces: readonly ClassifyAndScoutTrace[]
): readonly ClassifyAndScoutVisualRegion[] {
	return traces.flatMap((trace) => trace.regions.map((region) => visualRegion(trace, region)));
}

/** Checks identity and row cardinality; it does not infer or recompute geometry. */
export function assertClassifyAndScoutCorrespondence(evidence: ClassifyAndScoutEvidence): void {
	const rows = evidence.cliText.split('\n').filter((line) => line.startsWith('spatial regionId='));
	if (rows.length !== evidence.visualRender.overlays.length) {
		throw new Error('evidence correspondence mismatch: spatial row count');
	}
	rows.forEach((line, index) => {
		const marker = ' data=';
		const actual = JSON.parse(
			line.slice(line.indexOf(marker) + marker.length)
		) as ClassifyAndScoutVisualRegion;
		if (JSON.stringify(actual) !== JSON.stringify(evidence.visualRender.overlays[index])) {
			throw new Error(`evidence correspondence mismatch: region ${index}`);
		}
	});
	if (
		evidence.visualRender.receipt.verdict === 'rejected' &&
		!evidence.visualRender.receipt.reason
	) {
		throw new Error('rejected receipt must retain reason');
	}
}
