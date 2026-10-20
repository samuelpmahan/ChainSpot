/**
 * Hand-picked point pairs between a course screenshot (source) and a basemap (target), as one fixture file, and their
 * fit through the app's own alignment estimators (`alignment/similarity`, `alignment/affine`) with residuals.
 *
 * Format `chainspot.alignment-pairs` version 1:
 *   { format, version, course, model: 'similarity' | 'affine',
 *     source:  { fileName, sha256?, widthPx, heightPx },
 *     basemap: { fileName, sha256?, widthPx, heightPx,
 *                naip?: { center: { lat, lon }, radiusMeters, sizePx },   // a radius-based NAIP export
 *                metersPerPixel?: number },                            // or a ground scale stated outright
 *     pairs: [ { id, label, enabled?, source: { xPx, yPx }, target: { xPx, yPx } | null } ] }
 * Source px are the screenshot's own (the course-geometry file's `source.frame`); target px are the basemap's own.
 * A pair whose target is still null (picked on the screenshot, waiting for the basemap) is kept and never used.
 *
 * Residuals are reported in px of the basemap and, only when the basemap has a known ground scale, in metres. Data
 * conditions (too few complete pairs, collinear points) are returned results, never throws.
 */
import { estimateAffine } from '../alignment/affine';
import { estimateSimilarity } from '../alignment/similarity';
import type { AlignmentModel, AlignmentPairInput, SerializableTransform, ValidationWarning } from '../alignment/types';
import { validateTransform } from '../alignment/validation';
import { naipMetersPerPixel } from '../naip';
import type { GeoPoint } from '../naip';

export const ALIGNMENT_PAIRS_FORMAT = 'chainspot.alignment-pairs';
export const ALIGNMENT_PAIRS_VERSION = 1;

export interface PxPoint {
	readonly xPx: number;
	readonly yPx: number;
}

export interface AlignmentPairRecord {
	readonly id: string;
	readonly label: string;
	readonly enabled: boolean;
	readonly source: PxPoint;
	readonly target: PxPoint | null;
}

export interface ImageRef {
	readonly fileName: string;
	readonly sha256?: string;
	readonly widthPx: number;
	readonly heightPx: number;
}

export interface BasemapRef extends ImageRef {
	readonly naip?: { readonly center: GeoPoint; readonly radiusMeters: number; readonly sizePx: number };
	readonly metersPerPixel?: number;
}

export interface AlignmentPairsFile {
	readonly format: typeof ALIGNMENT_PAIRS_FORMAT;
	readonly version: typeof ALIGNMENT_PAIRS_VERSION;
	readonly course: string;
	readonly model: AlignmentModel;
	readonly source: ImageRef;
	readonly basemap: BasemapRef;
	readonly pairs: readonly AlignmentPairRecord[];
}

export type AlignmentPairsParseResult =
	| { readonly ok: true; readonly file: AlignmentPairsFile }
	| { readonly ok: false; readonly error: { readonly path: string; readonly message: string } };

export interface GroundScale {
	readonly metersPerPixel: number;
	/** Where the scale comes from, e.g. "USGS NAIP export, 300 m radius at 2048 px". */
	readonly referent: string;
}

export interface PairResidual {
	readonly pairId: string;
	readonly label: string;
	readonly target: PxPoint;
	readonly expected: PxPoint;
	/** expected - target, px of the basemap. */
	readonly dxPx: number;
	readonly dyPx: number;
	readonly distancePx: number;
	/** distancePx on the ground; null when the basemap has no known ground scale. */
	readonly distanceM: number | null;
}

export interface ResidualSummary {
	readonly count: number;
	readonly rms: number;
	readonly median: number;
	readonly max: number;
	readonly maxPairId: string | null;
}

export type AlignmentFitReport =
	| {
			readonly ok: true;
			readonly model: AlignmentModel;
			readonly transform: SerializableTransform;
			readonly residuals: readonly PairResidual[];
			/** px of the basemap. */
			readonly residualsPx: ResidualSummary;
			/** metres on the ground; null when the basemap has no known ground scale. */
			readonly residualsM: ResidualSummary | null;
			readonly groundScale: GroundScale | null;
			readonly warnings: readonly ValidationWarning[];
			readonly usedPairIds: readonly string[];
			/** Pairs left out: disabled, or target not picked yet. */
			readonly unusedPairIds: readonly string[];
	  }
	| {
			readonly ok: false;
			readonly model: AlignmentModel;
			readonly reason: string;
			readonly requiredPairs?: number;
			readonly availablePairs?: number;
			readonly groundScale: GroundScale | null;
	  };

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isPositiveInt = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0;

function readPoint(value: unknown): PxPoint | null {
	if (!isRecord(value) || !isFiniteNumber(value.xPx) || !isFiniteNumber(value.yPx)) return null;
	return { xPx: value.xPx, yPx: value.yPx };
}

function readImage(value: unknown, path: string): ImageRef | string {
	if (!isRecord(value) || typeof value.fileName !== 'string') return `${path}.fileName must be a string`;
	if (!isPositiveInt(value.widthPx) || !isPositiveInt(value.heightPx)) return `${path}.widthPx and .heightPx must be positive integers`;
	if (value.sha256 !== undefined && (typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256))) {
		return `${path}.sha256 must be 64 lowercase hex characters`;
	}
	return {
		fileName: value.fileName,
		widthPx: value.widthPx,
		heightPx: value.heightPx,
		...(typeof value.sha256 === 'string' ? { sha256: value.sha256 } : {})
	};
}

export function parseAlignmentPairs(text: string): AlignmentPairsParseResult {
	const fail = (path: string, message: string): AlignmentPairsParseResult => ({ ok: false, error: { path, message } });
	let root: unknown;
	try {
		root = JSON.parse(text);
	} catch (caught) {
		return fail('$', `not JSON: ${caught instanceof Error ? caught.message : String(caught)}`);
	}
	if (!isRecord(root)) return fail('$', 'must be an object');
	if (root.format !== ALIGNMENT_PAIRS_FORMAT) return fail('format', `must be '${ALIGNMENT_PAIRS_FORMAT}'`);
	if (root.version !== ALIGNMENT_PAIRS_VERSION) return fail('version', `must be ${ALIGNMENT_PAIRS_VERSION}`);
	if (typeof root.course !== 'string') return fail('course', 'must be a string');
	if (root.model !== 'similarity' && root.model !== 'affine') return fail('model', "must be 'similarity' or 'affine'");
	const source = readImage(root.source, 'source');
	if (typeof source === 'string') return fail('source', source);
	const basemapImage = readImage(root.basemap, 'basemap');
	if (typeof basemapImage === 'string') return fail('basemap', basemapImage);
	const basemapRaw = root.basemap as Record<string, unknown>;
	let basemap: BasemapRef = basemapImage;
	if (basemapRaw.naip !== undefined) {
		const naip = basemapRaw.naip;
		if (
			!isRecord(naip) ||
			!isRecord(naip.center) ||
			!isFiniteNumber(naip.center.lat) ||
			!isFiniteNumber(naip.center.lon) ||
			!isFiniteNumber(naip.radiusMeters) ||
			naip.radiusMeters <= 0 ||
			!isPositiveInt(naip.sizePx)
		) {
			return fail('basemap.naip', 'needs center { lat, lon }, a positive radiusMeters and an integer sizePx');
		}
		if (naip.sizePx !== basemapImage.widthPx || naip.sizePx !== basemapImage.heightPx) {
			return fail('basemap.naip.sizePx', 'a radius-based NAIP export is square: sizePx must equal widthPx and heightPx');
		}
		basemap = {
			...basemap,
			naip: { center: { lat: naip.center.lat, lon: naip.center.lon }, radiusMeters: naip.radiusMeters, sizePx: naip.sizePx }
		};
	}
	if (basemapRaw.metersPerPixel !== undefined) {
		if (!isFiniteNumber(basemapRaw.metersPerPixel) || basemapRaw.metersPerPixel <= 0) {
			return fail('basemap.metersPerPixel', 'must be a positive number');
		}
		basemap = { ...basemap, metersPerPixel: basemapRaw.metersPerPixel };
	}
	if (!Array.isArray(root.pairs)) return fail('pairs', 'must be an array');
	const ids = new Set<string>();
	const pairs: AlignmentPairRecord[] = [];
	for (const [index, item] of root.pairs.entries()) {
		const path = `pairs[${index}]`;
		if (!isRecord(item) || typeof item.id !== 'string' || item.id === '') return fail(`${path}.id`, 'must be a non-empty string');
		if (ids.has(item.id)) return fail(`${path}.id`, `duplicate id '${item.id}'`);
		ids.add(item.id);
		const src = readPoint(item.source);
		if (!src) return fail(`${path}.source`, 'needs finite xPx and yPx');
		const target = item.target === null ? null : readPoint(item.target);
		if (item.target !== null && !target) return fail(`${path}.target`, 'needs finite xPx and yPx, or null while unpicked');
		pairs.push({
			id: item.id,
			label: typeof item.label === 'string' ? item.label : item.id,
			enabled: item.enabled !== false,
			source: src,
			target
		});
	}
	return {
		ok: true,
		file: { format: ALIGNMENT_PAIRS_FORMAT, version: ALIGNMENT_PAIRS_VERSION, course: root.course, model: root.model, source, basemap, pairs }
	};
}

/** The basemap's ground scale, when it has one: a radius-based NAIP export, or one stated outright. */
export function basemapGroundScale(basemap: BasemapRef): GroundScale | null {
	if (basemap.naip) {
		return {
			metersPerPixel: naipMetersPerPixel(basemap.naip.radiusMeters, basemap.naip.sizePx),
			referent: `USGS NAIP export, ${basemap.naip.radiusMeters} m radius at ${basemap.naip.sizePx} px (${basemap.fileName})`
		};
	}
	if (basemap.metersPerPixel !== undefined) {
		return { metersPerPixel: basemap.metersPerPixel, referent: `stated ground scale of ${basemap.fileName}` };
	}
	return null;
}

function summarize(values: readonly { id: string; value: number }[]): ResidualSummary {
	if (values.length === 0) return { count: 0, rms: 0, median: 0, max: 0, maxPairId: null };
	const sorted = values.map((entry) => entry.value).sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	let max = values[0];
	for (const entry of values) if (entry.value > max.value) max = entry;
	return {
		count: values.length,
		rms: Math.sqrt(sorted.reduce((sum, value) => sum + value * value, 0) / sorted.length),
		median: sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
		max: max.value,
		maxPairId: max.id
	};
}

export interface FitOptions {
	/**
	 * Ground scale of the SOURCE screenshot, e.g. from the course-geometry file's C1 circle (10 m = rC1 px). Used only
	 * when the basemap has none: carried through the fit as source m/px divided by the fit's linear scale
	 * (sqrt |det|, exact for a similarity).
	 */
	readonly sourceGroundScale?: GroundScale;
}

export function fitAlignmentPairs(file: AlignmentPairsFile, options: FitOptions = {}): AlignmentFitReport {
	let groundScale = basemapGroundScale(file.basemap);
	const inputs: AlignmentPairInput[] = file.pairs.map((pair) => ({
		id: pair.id,
		enabled: pair.enabled,
		source: pair.source,
		target: pair.target
	}));
	const estimate = file.model === 'affine' ? estimateAffine({ pairs: inputs }) : estimateSimilarity({ pairs: inputs });
	if (!('transform' in estimate)) {
		return {
			ok: false,
			model: file.model,
			reason: estimate.reason,
			...(estimate.requiredPairs !== undefined ? { requiredPairs: estimate.requiredPairs } : {}),
			...(estimate.availablePairs !== undefined ? { availablePairs: estimate.availablePairs } : {}),
			groundScale
		};
	}
	if (!groundScale && options.sourceGroundScale) {
		const linear = Math.sqrt(Math.abs(estimate.transform.determinant));
		groundScale = {
			metersPerPixel: options.sourceGroundScale.metersPerPixel / linear,
			referent: `${options.sourceGroundScale.referent}, carried through the ${estimate.model} fit (x${linear.toFixed(4)})`
		};
	}
	const labels = new Map(file.pairs.map((pair) => [pair.id, pair.label]));
	const residuals: PairResidual[] = estimate.residuals.map((residual) => ({
		pairId: residual.pairId,
		label: labels.get(residual.pairId) ?? residual.pairId,
		target: residual.target,
		expected: residual.expected,
		dxPx: residual.dx,
		dyPx: residual.dy,
		distancePx: residual.distance,
		distanceM: groundScale ? residual.distance * groundScale.metersPerPixel : null
	}));
	const used = new Set(estimate.usedPairIds);
	return {
		ok: true,
		model: estimate.model,
		transform: estimate.transform,
		residuals,
		residualsPx: summarize(residuals.map((r) => ({ id: r.pairId, value: r.distancePx }))),
		residualsM: groundScale ? summarize(residuals.map((r) => ({ id: r.pairId, value: r.distanceM as number }))) : null,
		groundScale,
		warnings: validateTransform({ transform: estimate.transform, pairs: inputs }),
		usedPairIds: estimate.usedPairIds,
		unusedPairIds: file.pairs.filter((pair) => !used.has(pair.id)).map((pair) => pair.id)
	};
}
