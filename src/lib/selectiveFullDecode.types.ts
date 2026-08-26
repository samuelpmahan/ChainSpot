import type { CapturedSource } from './sourceIntake';
import type { ClassifyAndScoutTrace, ScoutRectPx } from './classifyAndScout.types';

export const SELECTIVE_FULL_DECODE_FEATURE_ID = 'selective-full-decode';

export interface SelectiveFullDecodeOptions {
	readonly runId: string;
	readonly paramsHash: string;
	readonly featureId?: typeof SELECTIVE_FULL_DECODE_FEATURE_ID;
}

export interface CropRectPx {
	readonly leftPx: number;
	readonly topPx: number;
	readonly widthPx: number;
	readonly heightPx: number;
}

export interface SelectiveDecodeMeasurement {
	readonly name: string;
	readonly value: number | 'UNKNOWN';
	readonly unit: string;
	readonly provenance: string;
}

export type SelectiveFullDecodeTrace = {
	readonly runId: string;
	readonly imageId: string;
	readonly paramsHash: string;
	readonly featureId: typeof SELECTIVE_FULL_DECODE_FEATURE_ID;
	readonly traceHash: string;
	readonly upstreamTraceHash: string;
	readonly objectIds: {
		readonly source: string;
		readonly classification: string;
		readonly region: string;
		readonly crop?: string;
	};
	readonly requestedSourceRect: ScoutRectPx | 'UNKNOWN';
	readonly cropRect: CropRectPx | 'UNKNOWN';
	readonly geometryProvenance: string;
	readonly measurements: readonly SelectiveDecodeMeasurement[];
	readonly timingsMs: {
		readonly request: number;
		readonly decode: number;
		readonly total: number;
	};
	/** Runtime-only decoded bitmap; excluded from traceHash. */
	readonly bitmap?: ImageBitmap;
	readonly verdict: 'accepted' | 'rejected';
	readonly reason?: string;
};

export interface SelectiveFullDecodeBatch {
	readonly runId: string;
	readonly paramsHash: string;
	readonly featureId: typeof SELECTIVE_FULL_DECODE_FEATURE_ID;
	readonly traces: readonly SelectiveFullDecodeTrace[];
	readonly timingsMs: {
		readonly sourceIndex: number;
		readonly candidateSelection: number;
		readonly decode: number;
		readonly total: number;
	};
}

export type SelectiveDecodeFn = (
	file: File,
	leftPx: number,
	topPx: number,
	widthPx: number,
	heightPx: number
) => Promise<ImageBitmap>;

export type SelectiveFullDecodeProducer = (
	sources: readonly CapturedSource[],
	traces: readonly ClassifyAndScoutTrace[],
	options: Required<SelectiveFullDecodeOptions>
) => Promise<SelectiveFullDecodeBatch>;
