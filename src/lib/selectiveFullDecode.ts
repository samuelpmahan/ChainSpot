import { sha256HexSyncText } from '@chainspot/alg/exec/sha256';
import type { CapturedSource } from './sourceIntake';
import type { ClassifyAndScoutTrace, ScoutRectPx } from './classifyAndScout.types';
import {
	SELECTIVE_FULL_DECODE_FEATURE_ID,
	type CropRectPx,
	type SelectiveDecodeFn,
	type SelectiveDecodeMeasurement,
	type SelectiveFullDecodeBatch,
	type SelectiveFullDecodeOptions,
	type SelectiveFullDecodeTrace
} from './selectiveFullDecode.types';

export const SELECTIVE_FULL_DECODE_PROVENANCE =
	'selective-full-decode@1.0.0: floor(left/top), ceil(right/bottom), then clamp to numeric source dimensions; half-open [left,right) x [top,bottom)';

export const SELECTIVE_FULL_DECODE_REASONS = {
	UNAVAILABLE_SOURCE: 'unavailable-captured-source',
	UNKNOWN_RECT: 'UNKNOWN-rect',
	INVALID_BOUNDS: 'invalid-nonfinite-bounds',
	EMPTY_RECT: 'empty-rect-after-clamp',
	UPSTREAM_REJECTED: 'upstream-rejected-or-non-required-region',
	UNKNOWN_SOURCE_DIMENSIONS: 'UNKNOWN-source-dimensions',
	INVALID_SOURCE_DIMENSIONS: 'invalid-source-dimensions',
	DECODE_FAILURE: 'decode-failure'
} as const;

type Dimensions = { readonly widthPx: number | 'UNKNOWN'; readonly heightPx: number | 'UNKNOWN' };

function clock(): number {
	return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function finiteRect(rect: ScoutRectPx): boolean {
	return [rect.leftPx, rect.topPx, rect.rightPx, rect.bottomPx].every(Number.isFinite);
}

/**
 * Convert a continuous source-space half-open rectangle into the integer crop
 * requested by createImageBitmap. The right/bottom edges are exclusive.
 */
export function integerCropRect(rect: ScoutRectPx, source: Dimensions): CropRectPx | undefined {
	if (!finiteRect(rect)) return undefined;
	const maxWidth =
		typeof source.widthPx === 'number' && Number.isFinite(source.widthPx)
			? source.widthPx
			: Infinity;
	const maxHeight =
		typeof source.heightPx === 'number' && Number.isFinite(source.heightPx)
			? source.heightPx
			: Infinity;
	const left = Math.max(0, Math.min(maxWidth, Math.floor(rect.leftPx)));
	const top = Math.max(0, Math.min(maxHeight, Math.floor(rect.topPx)));
	const right = Math.max(0, Math.min(maxWidth, Math.ceil(rect.rightPx)));
	const bottom = Math.max(0, Math.min(maxHeight, Math.ceil(rect.bottomPx)));
	if (right <= left || bottom <= top) return undefined;
	return { leftPx: left, topPx: top, widthPx: right - left, heightPx: bottom - top };
}

function measurements(
	rect: ScoutRectPx | 'UNKNOWN',
	crop: CropRectPx | 'UNKNOWN',
	source: Dimensions
): readonly SelectiveDecodeMeasurement[] {
	const rows: SelectiveDecodeMeasurement[] = [
		{
			name: 'sourceWidth',
			value: source.widthPx,
			unit: 'pixels',
			provenance: 'classify-and-scout trace source.widthPx'
		},
		{
			name: 'sourceHeight',
			value: source.heightPx,
			unit: 'pixels',
			provenance: 'classify-and-scout trace source.heightPx'
		}
	];
	if (rect !== 'UNKNOWN') {
		rows.push(
			{
				name: 'requestedLeft',
				value: rect.leftPx,
				unit: 'pixels',
				provenance: 'classify-and-scout region.sourceRect; source-space half-open edge'
			},
			{
				name: 'requestedTop',
				value: rect.topPx,
				unit: 'pixels',
				provenance: 'classify-and-scout region.sourceRect; source-space half-open edge'
			},
			{
				name: 'requestedRight',
				value: rect.rightPx,
				unit: 'pixels',
				provenance: 'classify-and-scout region.sourceRect; source-space half-open edge'
			},
			{
				name: 'requestedBottom',
				value: rect.bottomPx,
				unit: 'pixels',
				provenance: 'classify-and-scout region.sourceRect; source-space half-open edge'
			}
		);
	}
	if (crop !== 'UNKNOWN') {
		rows.push(
			{
				name: 'cropLeft',
				value: crop.leftPx,
				unit: 'pixels',
				provenance: SELECTIVE_FULL_DECODE_PROVENANCE
			},
			{
				name: 'cropTop',
				value: crop.topPx,
				unit: 'pixels',
				provenance: SELECTIVE_FULL_DECODE_PROVENANCE
			},
			{
				name: 'cropWidth',
				value: crop.widthPx,
				unit: 'pixels',
				provenance: SELECTIVE_FULL_DECODE_PROVENANCE
			},
			{
				name: 'cropHeight',
				value: crop.heightPx,
				unit: 'pixels',
				provenance: SELECTIVE_FULL_DECODE_PROVENANCE
			}
		);
	}
	return rows;
}

function semanticTrace(
	trace: Omit<SelectiveFullDecodeTrace, 'traceHash' | 'bitmap' | 'timingsMs'>
): string {
	return JSON.stringify(trace);
}

function finish(
	base: Omit<SelectiveFullDecodeTrace, 'traceHash'>,
	bitmap?: ImageBitmap
): SelectiveFullDecodeTrace {
	const { timingsMs: _timingsMs, bitmap: _bitmap, ...semantic } = base;
	return {
		...base,
		traceHash: sha256HexSyncText(semanticTrace(semantic)),
		...(bitmap ? { bitmap } : {})
	};
}

function rejected(
	options: Required<SelectiveFullDecodeOptions>,
	upstream: ClassifyAndScoutTrace,
	regionId: string,
	requestedSourceRect: ScoutRectPx | 'UNKNOWN',
	reason: string,
	source: Dimensions,
	requestMs: number,
	totalMs: number
): SelectiveFullDecodeTrace {
	return finish({
		runId: options.runId,
		imageId: upstream.imageId,
		paramsHash: options.paramsHash,
		featureId: SELECTIVE_FULL_DECODE_FEATURE_ID,
		upstreamTraceHash: upstream.traceHash,
		objectIds: {
			source: upstream.objectIds.source,
			classification: upstream.objectIds.classification,
			region: regionId
		},
		requestedSourceRect,
		cropRect: 'UNKNOWN',
		geometryProvenance: SELECTIVE_FULL_DECODE_PROVENANCE,
		measurements: measurements(requestedSourceRect, 'UNKNOWN', source),
		timingsMs: { request: requestMs, decode: 0, total: totalMs },
		verdict: 'rejected',
		reason
	});
}

function sourceDimensions(upstream: ClassifyAndScoutTrace): Dimensions {
	return { widthPx: upstream.source.widthPx, heightPx: upstream.source.heightPx };
}

function sourceDimensionsReason(source: Dimensions): string | undefined {
	if (source.widthPx === 'UNKNOWN' || source.heightPx === 'UNKNOWN') {
		return SELECTIVE_FULL_DECODE_REASONS.UNKNOWN_SOURCE_DIMENSIONS;
	}
	if (
		!Number.isFinite(source.widthPx) ||
		!Number.isFinite(source.heightPx) ||
		source.widthPx <= 0 ||
		source.heightPx <= 0
	) {
		return SELECTIVE_FULL_DECODE_REASONS.INVALID_SOURCE_DIMENSIONS;
	}
	return undefined;
}

/** Browser decoder used only after Tick 4 has named a required candidate crop. */
export const decodeImageBitmapCrop: SelectiveDecodeFn = (file, leftPx, topPx, widthPx, heightPx) =>
	createImageBitmap(file, leftPx, topPx, widthPx, heightPx);

export async function produceSelectiveFullDecode(
	sources: readonly CapturedSource[],
	traces: readonly ClassifyAndScoutTrace[],
	options: SelectiveFullDecodeOptions,
	decode: SelectiveDecodeFn = decodeImageBitmapCrop
): Promise<SelectiveFullDecodeBatch> {
	const normalized = {
		...options,
		featureId: options.featureId ?? SELECTIVE_FULL_DECODE_FEATURE_ID
	} as Required<SelectiveFullDecodeOptions>;
	const started = clock();
	const sourceIndexStarted = clock();
	const sourceById = new Map(sources.map((source) => [source.imageId, source]));
	const sourceIndexMs = clock() - sourceIndexStarted;
	const candidateStarted = clock();
	const rows: Array<{
		upstream: ClassifyAndScoutTrace;
		regionId: string;
		requested: ScoutRectPx | 'UNKNOWN';
		required: boolean;
		source: CapturedSource | undefined;
	}> = [];
	for (const upstream of traces) {
		if (upstream.regions.length === 0) {
			rows.push({
				upstream,
				regionId: `${upstream.imageId}:no-region`,
				requested: 'UNKNOWN',
				required: false,
				source: sourceById.get(upstream.imageId)
			});
			continue;
		}
		for (const region of upstream.regions) {
			rows.push({
				upstream,
				regionId: region.regionId,
				requested: region.sourceRect,
				required:
					upstream.classification === 'thrown' &&
					upstream.verdict === 'accepted' &&
					region.verdict === 'candidate',
				source: sourceById.get(upstream.imageId)
			});
		}
	}
	const candidateSelectionMs = clock() - candidateStarted;
	const decodeStarted = clock();
	const result = await Promise.all(
		rows.map(async ({ upstream, regionId, requested, required, source }) => {
			const rowStarted = clock();
			const dimensions = sourceDimensions(upstream);
			const requestStarted = clock();
			if (!required)
				return rejected(
					normalized,
					upstream,
					regionId,
					requested,
					SELECTIVE_FULL_DECODE_REASONS.UPSTREAM_REJECTED,
					dimensions,
					clock() - requestStarted,
					clock() - rowStarted
				);
			if (!source)
				return rejected(
					normalized,
					upstream,
					regionId,
					requested,
					SELECTIVE_FULL_DECODE_REASONS.UNAVAILABLE_SOURCE,
					dimensions,
					clock() - requestStarted,
					clock() - rowStarted
				);
			const dimensionsReason = sourceDimensionsReason(dimensions);
			if (dimensionsReason)
				return rejected(
					normalized,
					upstream,
					regionId,
					requested,
					dimensionsReason,
					dimensions,
					clock() - requestStarted,
					clock() - rowStarted
				);
			if (requested === 'UNKNOWN')
				return rejected(
					normalized,
					upstream,
					regionId,
					requested,
					SELECTIVE_FULL_DECODE_REASONS.UNKNOWN_RECT,
					dimensions,
					clock() - requestStarted,
					clock() - rowStarted
				);
			if (!finiteRect(requested))
				return rejected(
					normalized,
					upstream,
					regionId,
					requested,
					SELECTIVE_FULL_DECODE_REASONS.INVALID_BOUNDS,
					dimensions,
					clock() - requestStarted,
					clock() - rowStarted
				);
			const crop = integerCropRect(requested, dimensions);
			if (!crop)
				return rejected(
					normalized,
					upstream,
					regionId,
					requested,
					SELECTIVE_FULL_DECODE_REASONS.EMPTY_RECT,
					dimensions,
					clock() - requestStarted,
					clock() - rowStarted
				);
			const requestMs = clock() - requestStarted;
			const decodeAt = clock();
			try {
				const bitmap = await decode(
					source.file,
					crop.leftPx,
					crop.topPx,
					crop.widthPx,
					crop.heightPx
				);
				const totalMs = clock() - rowStarted;
				return finish(
					{
						runId: normalized.runId,
						imageId: upstream.imageId,
						paramsHash: normalized.paramsHash,
						featureId: SELECTIVE_FULL_DECODE_FEATURE_ID,
						upstreamTraceHash: upstream.traceHash,
						objectIds: {
							source: upstream.objectIds.source,
							classification: upstream.objectIds.classification,
							region: regionId,
							crop: `${regionId}:full-crop`
						},
						requestedSourceRect: requested,
						cropRect: crop,
						geometryProvenance: SELECTIVE_FULL_DECODE_PROVENANCE,
						measurements: measurements(requested, crop, dimensions),
						timingsMs: { request: requestMs, decode: clock() - decodeAt, total: totalMs },
						verdict: 'accepted'
					},
					bitmap
				);
			} catch {
				return rejected(
					normalized,
					upstream,
					regionId,
					requested,
					SELECTIVE_FULL_DECODE_REASONS.DECODE_FAILURE,
					dimensions,
					requestMs,
					clock() - rowStarted
				);
			}
		})
	);
	return {
		runId: normalized.runId,
		paramsHash: normalized.paramsHash,
		featureId: SELECTIVE_FULL_DECODE_FEATURE_ID,
		traces: result,
		timingsMs: {
			sourceIndex: sourceIndexMs,
			candidateSelection: candidateSelectionMs,
			decode: clock() - decodeStarted,
			total: clock() - started
		}
	};
}
