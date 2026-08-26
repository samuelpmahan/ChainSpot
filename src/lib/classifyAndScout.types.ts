import type { PixelCenterTransform, ScoutThumbnailTrace } from './scoutThumbnails.types';

export const CLASSIFY_AND_SCOUT_FEATURE_ID = 'classify-and-scout';

/** A continuous pixel rectangle using half-open bounds: [left,right) x [top,bottom). */
export interface ScoutRectPx {
	readonly leftPx: number;
	readonly topPx: number;
	readonly rightPx: number;
	readonly bottomPx: number;
}

export type ScoutClassification = 'thrown' | 'map' | 'unknown';
export type ScoutRegionVerdict = 'candidate' | 'rejected';

export interface ScoutMeasurement {
	readonly name: string;
	readonly value: number | 'UNKNOWN';
	readonly unit: string;
	readonly provenance: string;
}

/** One retained candidate or rejection. UNKNOWN geometry is allowed only when its thumbnail trace was rejected. */
export interface ScoutRegion {
	readonly regionId: string;
	readonly imageId: string;
	readonly kind: 'purple-mass';
	readonly verdict: ScoutRegionVerdict;
	readonly thumbnailRect: ScoutRectPx | 'UNKNOWN';
	readonly sourceRect: ScoutRectPx | 'UNKNOWN';
	readonly measurements: readonly ScoutMeasurement[];
	readonly reason: string;
}

export interface ClassifyAndScoutTimingsMs {
	readonly thumbnailPixelRead: number;
	readonly signalMeasurement: number;
	readonly classification: number;
	readonly regionGeneration: number;
	readonly transform: number;
	readonly total: number;
}

/** Reviewed trace. `thumbnailBitmap` is a runtime-only visual handle and must not enter `traceHash`. */
export interface ClassifyAndScoutTrace {
	readonly runId: string;
	readonly imageId: string;
	readonly paramsHash: string;
	readonly featureId: typeof CLASSIFY_AND_SCOUT_FEATURE_ID;
	readonly traceHash: string;
	readonly thumbnailTraceHash: string;
	readonly objectIds: { readonly source: string; readonly thumbnail?: string; readonly classification: string };
	readonly source: ScoutThumbnailTrace['source'];
	readonly thumbnail: ScoutThumbnailTrace['thumbnail'];
	readonly transform: PixelCenterTransform | 'UNKNOWN';
	readonly thumbnailBitmap?: ImageBitmap;
	readonly classification: ScoutClassification;
	readonly regions: readonly ScoutRegion[];
	readonly timingsMs: ClassifyAndScoutTimingsMs;
	readonly verdict: 'accepted' | 'rejected';
	readonly reason?: string;
}

export interface ClassifyAndScoutOptions {
	readonly runId: string;
	readonly paramsHash: string;
	readonly featureId?: typeof CLASSIFY_AND_SCOUT_FEATURE_ID;
}

export interface ClassifyAndScoutProducer {
	(trace: ScoutThumbnailTrace, options: Required<ClassifyAndScoutOptions>): Promise<ClassifyAndScoutTrace>;
}
