import { measurePurpleMass, purpleMassBounds } from '@chainspot/alg/detectors/purpleMass';
import type { RgbaRaster } from '@chainspot/alg/detect';
import { sha256HexSyncText } from '@chainspot/alg/exec/sha256';
import type { PixelCenterTransform, ScoutThumbnailTrace } from './scoutThumbnails.types';
import type {
	ClassifyAndScoutOptions,
	ClassifyAndScoutProducer,
	ClassifyAndScoutTrace,
	ScoutMeasurement,
	ScoutRectPx,
	ScoutRegion
} from './classifyAndScout.types';
import { CLASSIFY_AND_SCOUT_FEATURE_ID } from './classifyAndScout.types';

const PROVENANCE = 'purple-path-mass@1.0.0: hue 245..275 deg, saturation >= 0.35, value >= 0.35';
const clock = () => (typeof performance === 'undefined' ? Date.now() : performance.now());

/** Half-open thumbnail edges map to half-open source edges (the edge form of the accepted pixel-center transform). */
export function mapRect(
	rect: ScoutRectPx,
	transform: PixelCenterTransform,
	source?: ScoutThumbnailTrace['source']
): ScoutRectPx {
	return {
		leftPx: Math.max(0, rect.leftPx * transform.thumbnailToSource.sx),
		topPx: Math.max(0, rect.topPx * transform.thumbnailToSource.sy),
		rightPx: Math.min(
			typeof source?.widthPx === 'number' ? source.widthPx : Infinity,
			rect.rightPx * transform.thumbnailToSource.sx
		),
		bottomPx: Math.min(
			typeof source?.heightPx === 'number' ? source.heightPx : Infinity,
			rect.bottomPx * transform.thumbnailToSource.sy
		)
	};
}

function readThumbnailPixels(trace: ScoutThumbnailTrace): RgbaRaster {
	const bitmap = trace.thumbnailBitmap;
	if (!bitmap || !trace.thumbnail) throw new Error('thumbnail-pixels-unavailable');
	const canvas =
		typeof OffscreenCanvas !== 'undefined'
			? new OffscreenCanvas(bitmap.width, bitmap.height)
			: document.createElement('canvas');
	canvas.width = bitmap.width;
	canvas.height = bitmap.height;
	const context = canvas.getContext('2d');
	if (!context) throw new Error('thumbnail-2d-context-unavailable');
	context.drawImage(bitmap, 0, 0);
	return {
		imageId: trace.imageId,
		widthPx: bitmap.width,
		heightPx: bitmap.height,
		rgba: context.getImageData(0, 0, bitmap.width, bitmap.height).data
	};
}

/** Pure post-read stage; tests inject RGBA, production reads only the accepted thumbnail bitmap. */
export function classifyAndScoutRaster(
	trace: ScoutThumbnailTrace,
	options: Required<ClassifyAndScoutOptions>,
	image: RgbaRaster,
	thumbnailPixelRead: number
): ClassifyAndScoutTrace {
	const started = clock();
	const timings = {
		thumbnailPixelRead,
		signalMeasurement: 0,
		classification: 0,
		regionGeneration: 0,
		transform: 0,
		total: 0
	};
	let classification: ClassifyAndScoutTrace['classification'] = 'unknown';
	let regions: ScoutRegion[];
	try {
		let mark = clock();
		const measurement = measurePurpleMass(image);
		timings.signalMeasurement = clock() - mark;
		mark = clock();
		classification =
			measurement.intent === 'likely-thrown'
				? 'thrown'
				: measurement.intent === 'likely-map'
					? 'map'
					: 'unknown';
		timings.classification = clock() - mark;
		mark = clock();
		const thumbnailRect = purpleMassBounds(image.widthPx, image.heightPx, image.rgba) ?? 'UNKNOWN';
		timings.regionGeneration = clock() - mark;
		mark = clock();
		const sourceRect =
			thumbnailRect !== 'UNKNOWN' && trace.transform
				? mapRect(thumbnailRect, trace.transform, trace.source)
				: 'UNKNOWN';
		timings.transform = clock() - mark;
		const candidate = classification === 'thrown' && thumbnailRect !== 'UNKNOWN';
		const measurements: readonly ScoutMeasurement[] = [
			{
				name: 'purpleFraction',
				value: measurement.fraction,
				unit: 'fraction',
				provenance: PROVENANCE
			},
			{
				name: 'sampledPixels',
				value: measurement.sampledPixels,
				unit: 'pixels',
				provenance: 'purple-path-mass@1.0.0: stride ceil(sqrt(width*height/20000))'
			},
			{
				name: 'purplePixels',
				value: measurement.purplePixels,
				unit: 'pixels',
				provenance: PROVENANCE
			}
		];
		regions = [
			{
				regionId: `${trace.imageId}:purple-mass:0`,
				imageId: trace.imageId,
				kind: 'purple-mass',
				verdict: candidate ? 'candidate' : 'rejected',
				thumbnailRect,
				sourceRect,
				measurements,
				reason: candidate
					? 'purple-mass-bounds'
					: classification === 'map'
						? 'map-classification'
						: 'unknown-classification'
			}
		];
	} catch (error) {
		regions = [
			{
				regionId: `${trace.imageId}:purple-mass:0`,
				imageId: trace.imageId,
				kind: 'purple-mass',
				verdict: 'rejected',
				thumbnailRect: 'UNKNOWN',
				sourceRect: 'UNKNOWN',
				measurements: [],
				reason: error instanceof Error ? error.message : 'thumbnail-pixels-unavailable'
			}
		];
	}
	timings.total = clock() - started + thumbnailPixelRead;
	const base: Omit<ClassifyAndScoutTrace, 'traceHash' | 'thumbnailBitmap'> = {
		runId: options.runId,
		imageId: trace.imageId,
		paramsHash: options.paramsHash,
		featureId: CLASSIFY_AND_SCOUT_FEATURE_ID,
		thumbnailTraceHash: trace.traceHash,
		objectIds: {
			source: trace.objectIds.source,
			...(trace.objectIds.thumbnail ? { thumbnail: trace.objectIds.thumbnail } : {}),
			classification: `${trace.imageId}:classification`
		},
		source: trace.source,
		thumbnail: trace.thumbnail,
		transform: trace.transform ?? 'UNKNOWN',
		classification,
		regions,
		timingsMs: timings,
		verdict: regions.some((region) => region.verdict === 'candidate') ? 'accepted' : 'rejected',
		reason: regions[0].reason
	};
	const { timingsMs: _timingsMs, ...semanticTrace } = base;
	return {
		...base,
		traceHash: sha256HexSyncText(JSON.stringify(semanticTrace)),
		...(trace.thumbnailBitmap ? { thumbnailBitmap: trace.thumbnailBitmap } : {})
	};
}

export const produceClassifyAndScout: ClassifyAndScoutProducer = async (trace, options) => {
	const started = clock();
	try {
		return classifyAndScoutRaster(trace, options, readThumbnailPixels(trace), clock() - started);
	} catch (error) {
		const reason = error instanceof Error ? error.message : 'thumbnail-pixels-unavailable';
		const regions: ScoutRegion[] = [
			{
				regionId: `${trace.imageId}:purple-mass:0`,
				imageId: trace.imageId,
				kind: 'purple-mass',
				verdict: 'rejected',
				thumbnailRect: 'UNKNOWN',
				sourceRect: 'UNKNOWN',
				measurements: [],
				reason
			}
		];
		const base: Omit<ClassifyAndScoutTrace, 'traceHash' | 'thumbnailBitmap'> = {
			runId: options.runId,
			imageId: trace.imageId,
			paramsHash: options.paramsHash,
			featureId: CLASSIFY_AND_SCOUT_FEATURE_ID,
			thumbnailTraceHash: trace.traceHash,
			objectIds: {
				source: trace.objectIds.source,
				...(trace.objectIds.thumbnail ? { thumbnail: trace.objectIds.thumbnail } : {}),
				classification: `${trace.imageId}:classification`
			},
			source: trace.source,
			thumbnail: trace.thumbnail,
			transform: trace.transform ?? 'UNKNOWN',
			classification: 'unknown',
			regions,
			timingsMs: {
				thumbnailPixelRead: clock() - started,
				signalMeasurement: 0,
				classification: 0,
				regionGeneration: 0,
				transform: 0,
				total: clock() - started
			},
			verdict: 'rejected',
			reason
		};
		const { timingsMs: _timingsMs, ...semanticTrace } = base;
		return { ...base, traceHash: sha256HexSyncText(JSON.stringify(semanticTrace)) };
	}
};

export async function produceClassifyAndScouts(
	traces: readonly ScoutThumbnailTrace[],
	options: ClassifyAndScoutOptions,
	producer = produceClassifyAndScout
): Promise<readonly ClassifyAndScoutTrace[]> {
	const normalized = {
		...options,
		featureId: options.featureId ?? CLASSIFY_AND_SCOUT_FEATURE_ID
	} as Required<ClassifyAndScoutOptions>;
	const classified = await Promise.all(traces.map((trace) => producer(trace, normalized)));
	if (classified.filter((trace) => trace.classification === 'thrown').length === 1)
		return classified;
	return classified.map((trace) => {
		if (
			trace.reason === 'thumbnail-pixels-unavailable' ||
			trace.reason === 'thumbnail-2d-context-unavailable'
		)
			return trace;
		const regions = trace.regions.map((region) => ({
			...region,
			verdict: 'rejected' as const,
			reason: 'no-unique-thrown'
		}));
		const base = {
			...trace,
			classification: 'unknown' as const,
			regions,
			verdict: 'rejected' as const,
			reason: 'no-unique-thrown'
		};
		const { traceHash: _traceHash, thumbnailBitmap: _thumbnailBitmap, ...hashable } = base;
		return { ...base, traceHash: sha256HexSyncText(JSON.stringify(hashable)) };
	});
}
