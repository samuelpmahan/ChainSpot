/** Trace-only evidence models for scout thumbnails.
 *
 * This module deliberately does not decode pixels or recompute thumbnail
 * geometry. It turns producer traces into paired CLItext/VisualRender data.
 */

import type { ScoutThumbnailTrace } from './scoutThumbnails.types';

export type ScoutEvidenceTrace = ScoutThumbnailTrace;

export type ScoutThumbnailEvidence = {
	readonly mathText: string;
	readonly cliText: string;
	readonly visualRender: {
		readonly runId: string;
		readonly imageId: string;
		readonly paramsHash: string;
		readonly featureId: string;
		readonly traceHash: string;
		readonly sourceObjectId: string;
		readonly thumbnailObjectId: string;
		readonly source: ScoutEvidenceTrace['source'];
		readonly thumbnail: ScoutEvidenceTrace['thumbnail'] | 'UNKNOWN';
		readonly transform: ScoutEvidenceTrace['transform'] | 'UNKNOWN';
		readonly decoder: string;
		readonly resampler: string;
		readonly timingsMs: ScoutEvidenceTrace['timingsMs'];
		readonly verdict: ScoutEvidenceTrace['verdict'];
		readonly reason?: string;
	};
};

function renderObject(trace: ScoutEvidenceTrace): ScoutThumbnailEvidence['visualRender'] {
	return {
		runId: trace.runId,
		imageId: trace.imageId,
		paramsHash: trace.paramsHash,
		featureId: trace.featureId,
		traceHash: trace.traceHash,
		sourceObjectId: trace.objectIds.source,
		thumbnailObjectId: trace.objectIds.thumbnail ?? 'UNKNOWN',
		source: trace.source,
		thumbnail: trace.thumbnail ?? 'UNKNOWN',
		transform: trace.transform ?? 'UNKNOWN',
		decoder: trace.decoder,
		resampler: trace.resampler,
		timingsMs: trace.timingsMs,
		verdict: trace.verdict,
		reason: trace.reason
	};
}

function cliLine(trace: ScoutEvidenceTrace): string {
	const dims = ` source=${trace.source.widthPx}x${trace.source.heightPx} thumbnail=${trace.thumbnail ? `${trace.thumbnail.widthPx}x${trace.thumbnail.heightPx}` : 'UNKNOWN'}`;
	const reason = trace.reason ? ` reason=${trace.reason}` : '';
	const transform = trace.transform ? JSON.stringify(trace.transform) : 'UNKNOWN';
	return `scout-thumbnails runId=${trace.runId} imageId=${trace.imageId} paramsHash=${trace.paramsHash} featureId=${trace.featureId} traceHash=${trace.traceHash} sourceObjectId=${trace.objectIds.source} thumbnailObjectId=${trace.objectIds.thumbnail ?? 'UNKNOWN'}${dims} transform=${transform} decoder=${trace.decoder} resampler=${trace.resampler} timingsMs=${JSON.stringify(trace.timingsMs)} verdict=${trace.verdict}${reason}`;
}

export function toScoutThumbnailEvidence(trace: ScoutEvidenceTrace): ScoutThumbnailEvidence {
	return {
		mathText: [
			'scale = min(1, 256 / max(sourceWidth, sourceHeight))',
			'thumbnailDimension = max(1, round(sourceDimension * scale))',
			'thumbnail pixel center = (source pixel center + 0.5) * scale - 0.5',
			'source pixel center = (thumbnail pixel center + 0.5) / scale - 0.5'
		].join('\n'),
		cliText: cliLine(trace),
		visualRender: renderObject(trace)
	};
}

export function toScoutThumbnailContactSheet(
	traces: readonly ScoutEvidenceTrace[]
): readonly ScoutThumbnailEvidence['visualRender'][] {
	return traces.map(renderObject);
}

export function assertScoutThumbnailCorrespondence(
	cliText: string,
	visualRender: ScoutThumbnailEvidence['visualRender']
): void {
	for (const field of [
		'runId',
		'imageId',
		'paramsHash',
		'featureId',
		'traceHash',
		'sourceObjectId',
		'thumbnailObjectId',
		'decoder',
		'resampler'
	] as const) {
		if (!cliText.includes(`${field}=${visualRender[field]}`))
			throw new Error(`evidence correspondence mismatch: ${field}`);
	}
	for (const field of ['verdict'] as const) {
		if (!cliText.includes(`${field}=${visualRender[field]}`))
			throw new Error(`evidence correspondence mismatch: ${field}`);
	}
	if (!cliText.includes(`timingsMs=${JSON.stringify(visualRender.timingsMs)}`))
		throw new Error('evidence correspondence mismatch: timingsMs');
	if (
		!cliText.includes(
			`transform=${visualRender.transform === 'UNKNOWN' ? 'UNKNOWN' : JSON.stringify(visualRender.transform)}`
		)
	)
		throw new Error('evidence correspondence mismatch: transform');
	if (!cliText.includes(`source=${visualRender.source.widthPx}x${visualRender.source.heightPx}`))
		throw new Error('evidence correspondence mismatch: source dimensions');
	const thumbnail =
		visualRender.thumbnail == null || visualRender.thumbnail === 'UNKNOWN'
			? 'UNKNOWN'
			: `${visualRender.thumbnail.widthPx}x${visualRender.thumbnail.heightPx}`;
	if (!cliText.includes(`thumbnail=${thumbnail}`))
		throw new Error('evidence correspondence mismatch: thumbnail dimensions');
	if (visualRender.reason && !cliText.includes(`reason=${visualRender.reason}`))
		throw new Error('evidence correspondence mismatch: reason');
}
