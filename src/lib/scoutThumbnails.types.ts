import type { CapturedSource } from './sourceIntake';

export const SCOUT_THUMBNAIL_FEATURE_ID = 'scout-thumbnails';

export interface ScoutThumbnailParams {
	readonly maxSidePx: number;
}

export interface PixelCenterTransform {
	readonly sourceToThumbnail: { readonly sx: number; readonly sy: number };
	readonly thumbnailToSource: { readonly sx: number; readonly sy: number };
}

export type DecodedDimension = number | 'UNKNOWN';

export type ScoutThumbnailTrace = {
	readonly runId: string;
	readonly imageId: string;
	readonly paramsHash: string;
	readonly featureId: string;
	readonly traceHash: string;
	readonly objectIds: { readonly source: string; readonly thumbnail?: string };
	readonly source: { readonly widthPx: DecodedDimension; readonly heightPx: DecodedDimension };
	readonly thumbnail?: { readonly widthPx: number; readonly heightPx: number };
	/** Runtime handle for contact-sheet rendering; deliberately excluded from traceHash. */
	readonly thumbnailBitmap?: ImageBitmap;
	readonly transform?: PixelCenterTransform;
	readonly decoder: string;
	readonly resampler: string;
	readonly timingsMs: { readonly decode: number; readonly resize: number; readonly total: number };
	readonly verdict: 'accepted' | 'rejected';
	readonly reason?: string;
};

export interface ScoutThumbnailOptions {
	readonly runId: string;
	readonly paramsHash: string;
	readonly featureId?: string;
	readonly maxSidePx?: number;
}

export interface ScoutThumbnailProducer {
	(source: CapturedSource, options: Required<ScoutThumbnailOptions>): Promise<ScoutThumbnailTrace>;
}
