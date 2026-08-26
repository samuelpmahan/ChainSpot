import type { CapturedSource } from './sourceIntake';
import {
	SCOUT_THUMBNAIL_FEATURE_ID,
	type PixelCenterTransform,
	type ScoutThumbnailOptions,
	type ScoutThumbnailProducer,
	type ScoutThumbnailTrace
} from './scoutThumbnails.types';

export type { PixelCenterTransform, ScoutThumbnailOptions, ScoutThumbnailTrace } from './scoutThumbnails.types';
export type { ScoutThumbnailProducer } from './scoutThumbnails.types';

function elapsed(start: number): number {
	return performance.now() - start;
}

function dimensions(widthPx: number, heightPx: number, maxSidePx: number): { widthPx: number; heightPx: number } {
	if (!Number.isFinite(widthPx) || !Number.isFinite(heightPx) || widthPx < 1 || heightPx < 1) {
		throw new Error('decoded dimensions are invalid');
	}
	const scale = Math.min(1, maxSidePx / Math.max(widthPx, heightPx));
	return { widthPx: Math.max(1, Math.round(widthPx * scale)), heightPx: Math.max(1, Math.round(heightPx * scale)) };
}

export function scoutThumbnailTransform(
	sourceWidthPx: number,
	sourceHeightPx: number,
	thumbnailWidthPx: number,
	thumbnailHeightPx: number
): PixelCenterTransform {
	// Pixel centers map as (x_s + .5) * W_t / W_s and inverse to
	// (x_t + .5) * W_s / W_t - .5 (same formula independently for y).
	return {
		sourceToThumbnail: { sx: thumbnailWidthPx / sourceWidthPx, sy: thumbnailHeightPx / sourceHeightPx },
		thumbnailToSource: { sx: sourceWidthPx / thumbnailWidthPx, sy: sourceHeightPx / thumbnailHeightPx }
	};
}

function hashText(text: string): Promise<string> {
	return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then((bytes) =>
		Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
	);
}

/** Timings are displayed evidence, but are not stable semantic identity. */
function hashSemanticTrace(trace: { readonly timingsMs: unknown } & Record<string, unknown>): Promise<string> {
	const { timingsMs: _timingsMs, ...semanticTrace } = trace;
	return hashText(JSON.stringify(semanticTrace));
}

function requiredOptions(options: ScoutThumbnailOptions): Required<ScoutThumbnailOptions> {
	const maxSidePx = options.maxSidePx ?? 256;
	if (!Number.isInteger(maxSidePx) || maxSidePx < 1) throw new Error('maxSidePx must be a positive integer');
	return { ...options, featureId: options.featureId ?? SCOUT_THUMBNAIL_FEATURE_ID, maxSidePx };
}

async function rejected(source: CapturedSource, options: Required<ScoutThumbnailOptions>, reason: string, total: number) {
	const base = {
		runId: options.runId,
		imageId: source.imageId,
		paramsHash: options.paramsHash,
		featureId: options.featureId,
		objectIds: { source: source.imageId },
		source: { widthPx: 'UNKNOWN' as const, heightPx: 'UNKNOWN' as const },
		decoder: 'UNKNOWN',
		resampler: 'UNKNOWN',
		timingsMs: { decode: 0, resize: 0, total },
		verdict: 'rejected' as const,
		reason
	};
	return { ...base, traceHash: await hashSemanticTrace(base) };
}

/** Produce one browser thumbnail trace. The OFF path is intentionally absent here: callers dispatch only when enabled. */
export const produceScoutThumbnail: ScoutThumbnailProducer = async (source, rawOptions) => {
	const options = requiredOptions(rawOptions);
	const started = performance.now();
	try {
		const decodeStarted = performance.now();
		let bitmap: ImageBitmap;
		let decoder = 'createImageBitmap';
		if (typeof createImageBitmap === 'function') {
			bitmap = await createImageBitmap(source.file);
		} else {
			throw new Error('browser decoder unavailable');
		}
		const decode = elapsed(decodeStarted);
		const sourceSize = { widthPx: bitmap.width, heightPx: bitmap.height };
		const thumbnailSize = dimensions(bitmap.width, bitmap.height, options.maxSidePx);
		const resizeStarted = performance.now();
		let thumbnail: ImageBitmap;
		try {
			thumbnail = await createImageBitmap(source.file, {
				resizeWidth: thumbnailSize.widthPx,
				resizeHeight: thumbnailSize.heightPx,
				resizeQuality: 'high'
			});
		} finally {
			bitmap.close();
		}
		const resize = elapsed(resizeStarted);
		const transform = scoutThumbnailTransform(
			sourceSize.widthPx,
			sourceSize.heightPx,
			thumbnail.width,
			thumbnail.height
		);
		const base = {
			runId: options.runId,
			imageId: source.imageId,
			paramsHash: options.paramsHash,
			featureId: options.featureId,
			objectIds: { source: source.imageId, thumbnail: `${source.imageId}:thumbnail` },
			source: sourceSize,
			thumbnail: { widthPx: thumbnail.width, heightPx: thumbnail.height },
			transform,
			decoder,
			resampler: 'createImageBitmap.resizeQuality=high',
			timingsMs: { decode, resize, total: elapsed(started) },
			verdict: 'accepted' as const
		};
		const traceHash = await hashSemanticTrace(base);
		return { ...base, traceHash, thumbnailBitmap: thumbnail };
	} catch (error) {
		return rejected(source, options, error instanceof Error ? error.message : 'thumbnail-decode-failed', elapsed(started));
	}
};

export async function produceScoutThumbnails(
	sources: readonly CapturedSource[],
	options: ScoutThumbnailOptions,
	producer: ScoutThumbnailProducer = produceScoutThumbnail
): Promise<readonly ScoutThumbnailTrace[]> {
	const normalized = requiredOptions(options);
	return Promise.all(sources.map((source) => producer(source, normalized)));
}
