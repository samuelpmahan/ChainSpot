/**
 * Pure local tee/basket snap detector. The browser places the user's click
 * optimistically and this pass may settle it to a nearby feature.
 *
 * The important contract is explicit: a snap is not just point|null.
 * `localFeatureSnapDetailed` records the first stage that rejected the click,
 * the candidate population, the real detector score, and the calibration
 * evidence used. `localFeatureSnap` remains the compatibility wrapper used by
 * the staged worker, and emits the same structured trace to DevTools so a
 * failed live snap no longer disappears as an unexplained null.
 */

import {
	asUiScalePx,
	deriveCanonicalUiScalePx
} from '../autoAnnotation/cvCalibration';
import type { BasketTemplateScale, UiScalePx } from '../autoAnnotation/cvCalibration';
import {
	detectBasketCandidatesAtTemplateScale,
	detectCalibratedTeePadCandidates
} from '../autoAnnotation/cvCalibratedDetectors';
import type {
	CalibratedBasketCandidate,
	CalibratedTeePadDetectionOptions
} from '../autoAnnotation/cvCalibratedDetectors';
import type { TeePadCandidate, TeePadCv, TeePadRaster } from '../autoAnnotation/teePadDetection';
import type {
	BasketCv,
	BasketRaster,
	BasketTemplateRaster
} from '../autoAnnotation/basketTemplateDetection';
import type { LandmarkScore, LocalSnapRejectReason, LocalSnapTrace } from './landmarkTrace';

export type LocalSnapKind = 'tee' | 'basket';

export interface LocalSnapPoint {
	readonly xPx: number;
	readonly yPx: number;
}

export type LocalSnapCv = TeePadCv & BasketCv;

export interface LocalSnapRaster {
	readonly widthPx: number;
	readonly heightPx: number;
	readonly sourceScale: number;
	readonly rgba?: Uint8Array | Uint8ClampedArray;
	readonly gray?: Uint8Array;
}

export interface LocalSnapKnownRecommendation {
	readonly point: LocalSnapPoint;
	readonly holeNumber?: number;
	/** Measured full-course candidate footprint, not a confidence. */
	readonly featureFootprintPx?: number;
	readonly score?: LandmarkScore;
}

export interface LocalSnapCalibration {
	readonly uiScalePx: UiScalePx;
	readonly basket?: {
		readonly template: BasketTemplateRaster;
		readonly templateScale: BasketTemplateScale;
	};
	/** Optional full-course evidence for the same local feature family. */
	readonly knownRecommendation?: LocalSnapKnownRecommendation;
}

export interface LocalSnapOutcome {
	readonly point: LocalSnapPoint | null;
	readonly trace: LocalSnapTrace;
}

export interface LocalSnapSearchGeometry {
	readonly featureFootprintPx: number;
	readonly cropSidePx: number;
	readonly snapRadiusPx: number;
	readonly calibrationSource: string;
	readonly knownRecommendationDistancePx?: number;
	readonly knownRecommendationInRadius?: boolean;
}

export const TEE_PAD_MAX_FOOTPRINT_UI_SCALE_MULTIPLE = 26;
export const LOCAL_SNAP_CROP_FEATURE_MULTIPLE = 4;
export const LOCAL_SNAP_RADIUS_FEATURE_MULTIPLE = 0.5;
export const LOCAL_SNAP_MAX_ABSOLUTE_RADIUS_PX = 24;
export const LOCAL_SNAP_MIN_SCORE = 0.5;
/**
 * Tee sprite/pad footprint is not reliably proportional to UDisc badge UI
 * scale across the corpus. Full-course production already moved to a
 * world-normalized tee detector for this reason. Local snap remains a tiny
 * click-centered search, so the least invasive correction is a small scale
 * bank around the badge-derived baseline rather than pretending one UiScale
 * predicts every rendered pad. Radius and score gates stay unchanged.
 */
export const LOCAL_TEE_SNAP_SCALE_FACTORS = [0.75, 1, 1.5, 2, 2.5] as const;
const MIN_CROP_SIDE_PX = 4;
const TEE_SCALE_EVIDENCE_MIN_DELTA = 0.05;

interface CropBounds {
	readonly x0: number;
	readonly y0: number;
	readonly widthPx: number;
	readonly heightPx: number;
}

function finitePositive(value: number | undefined): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function defaultTeeFootprint(uiScalePx: UiScalePx): number {
	return TEE_PAD_MAX_FOOTPRINT_UI_SCALE_MULTIPLE * uiScalePx;
}

function featureFootprintSourcePx(kind: LocalSnapKind, calibration: LocalSnapCalibration): number | null {
	if (kind === 'tee') {
		const baseline = defaultTeeFootprint(calibration.uiScalePx);
		const bankMaximum = baseline * Math.max(...LOCAL_TEE_SNAP_SCALE_FACTORS);
		const measured = calibration.knownRecommendation?.featureFootprintPx;
		return finitePositive(measured) ? Math.max(bankMaximum, measured) : bankMaximum;
	}
	const basket = calibration.basket;
	if (!basket) return null;
	return Math.max(basket.template.widthPx, basket.template.heightPx) * basket.templateScale;
}

/** Pure search-geometry diagnostic used by tests/audit tooling without OpenCV. */
export function deriveLocalSnapSearchGeometry(
	kind: LocalSnapKind,
	clickPx: LocalSnapPoint,
	calibration: LocalSnapCalibration
): LocalSnapSearchGeometry | null {
	const featureFootprintPx = featureFootprintSourcePx(kind, calibration);
	if (featureFootprintPx === null || !(featureFootprintPx > 0)) return null;
	const snapRadiusPx = Math.min(
		featureFootprintPx * LOCAL_SNAP_RADIUS_FEATURE_MULTIPLE,
		LOCAL_SNAP_MAX_ABSOLUTE_RADIUS_PX
	);
	const known = calibration.knownRecommendation;
	const knownDistance = known
		? Math.hypot(known.point.xPx - clickPx.xPx, known.point.yPx - clickPx.yPx)
		: undefined;
	return {
		featureFootprintPx,
		cropSidePx: featureFootprintPx * LOCAL_SNAP_CROP_FEATURE_MULTIPLE,
		snapRadiusPx,
		calibrationSource:
			kind === 'tee'
				? finitePositive(known?.featureFootprintPx)
					? 'number-badge-ui-scale+tee-multiscale+full-course-footprint'
					: 'number-badge-ui-scale+tee-multiscale'
				: 'number-badge-template-scale',
		...(knownDistance === undefined
			? {}
			: {
				knownRecommendationDistancePx: knownDistance,
				knownRecommendationInRadius: knownDistance <= snapRadiusPx
			})
	};
}

function computeCropBounds(
	raster: Pick<LocalSnapRaster, 'widthPx' | 'heightPx' | 'sourceScale'>,
	clickPx: LocalSnapPoint,
	cropSourceSidePx: number
): CropBounds | null {
	if (!(cropSourceSidePx > 0) || !(raster.sourceScale > 0)) return null;
	if (raster.widthPx <= 0 || raster.heightPx <= 0) return null;
	const clickRasterX = clickPx.xPx / raster.sourceScale;
	const clickRasterY = clickPx.yPx / raster.sourceScale;
	const halfRasterPx = cropSourceSidePx / 2 / raster.sourceScale;
	const x0 = Math.max(0, Math.floor(clickRasterX - halfRasterPx));
	const y0 = Math.max(0, Math.floor(clickRasterY - halfRasterPx));
	const x1 = Math.min(raster.widthPx - 1, Math.ceil(clickRasterX + halfRasterPx));
	const y1 = Math.min(raster.heightPx - 1, Math.ceil(clickRasterY + halfRasterPx));
	const widthPx = x1 - x0 + 1;
	const heightPx = y1 - y0 + 1;
	if (widthPx < MIN_CROP_SIDE_PX || heightPx < MIN_CROP_SIDE_PX) return null;
	return { x0, y0, widthPx, heightPx };
}

function cropRgba(
	rgba: Uint8Array | Uint8ClampedArray,
	sourceWidthPx: number,
	bounds: CropBounds
): Uint8Array {
	const out = new Uint8Array(bounds.widthPx * bounds.heightPx * 4);
	for (let row = 0; row < bounds.heightPx; row += 1) {
		const srcStart = ((bounds.y0 + row) * sourceWidthPx + bounds.x0) * 4;
		const rowBytes = bounds.widthPx * 4;
		out.set(rgba.subarray(srcStart, srcStart + rowBytes), row * rowBytes);
	}
	return out;
}

function cropGray(gray: Uint8Array, sourceWidthPx: number, bounds: CropBounds): Uint8Array {
	const out = new Uint8Array(bounds.widthPx * bounds.heightPx);
	for (let row = 0; row < bounds.heightPx; row += 1) {
		const srcStart = (bounds.y0 + row) * sourceWidthPx + bounds.x0;
		out.set(gray.subarray(srcStart, srcStart + bounds.widthPx), row * bounds.widthPx);
	}
	return out;
}

function sameCandidate(a: TeePadCandidate, b: TeePadCandidate): boolean {
	return Math.hypot(a.xPx - b.xPx, a.yPx - b.yPx) <= 2;
}

function addDistinctCandidates(target: TeePadCandidate[], candidates: readonly TeePadCandidate[]): void {
	for (const candidate of candidates) {
		const duplicateIndex = target.findIndex((existing) => sameCandidate(existing, candidate));
		if (duplicateIndex < 0) {
			target.push(candidate);
			continue;
		}
		const oldScore = target[duplicateIndex].score ?? -Infinity;
		const newScore = candidate.score ?? -Infinity;
		if (newScore > oldScore) target[duplicateIndex] = candidate;
	}
}

function teeCropCandidates(
	cv: LocalSnapCv,
	raster: LocalSnapRaster,
	bounds: CropBounds,
	calibration: LocalSnapCalibration
): readonly TeePadCandidate[] | null {
	if (!raster.rgba) return null;
	const cropped: TeePadRaster = {
		rgba: cropRgba(raster.rgba, raster.widthPx, bounds),
		widthPx: bounds.widthPx,
		heightPx: bounds.heightPx,
		sourceScale: raster.sourceScale
	};
	const candidates: TeePadCandidate[] = [];
	for (const factor of LOCAL_TEE_SNAP_SCALE_FACTORS) {
		const scale = asUiScalePx(calibration.uiScalePx * factor, `Local tee snap scale x${factor}`);
		const options: CalibratedTeePadDetectionOptions = { uiScalePx: scale };
		addDistinctCandidates(candidates, detectCalibratedTeePadCandidates(cv, cropped, options));
	}

	const measuredFootprint = calibration.knownRecommendation?.featureFootprintPx;
	if (finitePositive(measuredFootprint)) {
		const measuredScale = measuredFootprint / TEE_PAD_MAX_FOOTPRINT_UI_SCALE_MULTIPLE;
		const nearestBankScale = Math.min(
			...LOCAL_TEE_SNAP_SCALE_FACTORS.map((factor) => calibration.uiScalePx * factor)
		);
		const deltaFromBaseline = Math.abs(measuredScale / calibration.uiScalePx - 1);
		if (deltaFromBaseline > TEE_SCALE_EVIDENCE_MIN_DELTA && Number.isFinite(nearestBankScale)) {
			const evidenceScale = asUiScalePx(measuredScale, 'Full-course tee-footprint snap scale');
			addDistinctCandidates(
				candidates,
				detectCalibratedTeePadCandidates(cv, cropped, { uiScalePx: evidenceScale })
			);
		}
	}
	return candidates;
}

function basketCropCandidates(
	cv: LocalSnapCv,
	raster: LocalSnapRaster,
	bounds: CropBounds,
	calibration: LocalSnapCalibration
): readonly CalibratedBasketCandidate[] | null {
	const basket = calibration.basket;
	if (!basket || !raster.gray) return null;
	const cropped: BasketRaster = {
		gray: cropGray(raster.gray, raster.widthPx, bounds),
		widthPx: bounds.widthPx,
		heightPx: bounds.heightPx,
		sourceScale: raster.sourceScale
	};
	return detectBasketCandidatesAtTemplateScale(cv, cropped, basket.template, {
		templateScale: basket.templateScale
	});
}

function rejected(
	clickPx: LocalSnapPoint,
	reason: LocalSnapRejectReason,
	extra: Partial<LocalSnapTrace> = {}
): LocalSnapOutcome {
	return {
		point: null,
		trace: { attempted: true, accepted: false, rejectReason: reason, clickPx, ...extra }
	};
}

function scoreOf(candidate: { readonly score?: number }): number {
	return candidate.score ?? -Infinity;
}

export function localFeatureSnapDetailed(
	kind: LocalSnapKind,
	cv: LocalSnapCv,
	raster: LocalSnapRaster,
	clickPx: LocalSnapPoint,
	calibration: LocalSnapCalibration
): LocalSnapOutcome {
	if (!Number.isFinite(clickPx.xPx) || !Number.isFinite(clickPx.yPx)) {
		return rejected(clickPx, 'invalid-click');
	}
	if (!(calibration.uiScalePx > 0)) return rejected(clickPx, 'invalid-calibration');
	const geometry = deriveLocalSnapSearchGeometry(kind, clickPx, calibration);
	if (!geometry) return rejected(clickPx, 'no-footprint');
	const common: Partial<LocalSnapTrace> = {
		featureFootprintPx: geometry.featureFootprintPx,
		snapRadiusPx: geometry.snapRadiusPx,
		calibrationSource: geometry.calibrationSource,
		...(geometry.knownRecommendationDistancePx === undefined ? {} : {
			knownRecommendationDistancePx: geometry.knownRecommendationDistancePx,
			knownRecommendationInRadius: geometry.knownRecommendationInRadius
		})
	};

	const bounds = computeCropBounds(raster, clickPx, geometry.cropSidePx);
	if (!bounds) return rejected(clickPx, 'empty-crop', common);
	if ((kind === 'tee' && !raster.rgba) || (kind === 'basket' && !raster.gray)) {
		return rejected(clickPx, 'missing-raster-channel', common);
	}

	const originXPx = bounds.x0 * raster.sourceScale;
	const originYPx = bounds.y0 * raster.sourceScale;
	const candidates = kind === 'tee'
		? teeCropCandidates(cv, raster, bounds, calibration)
		: basketCropCandidates(cv, raster, bounds, calibration);
	if (!candidates || candidates.length === 0) {
		return rejected(clickPx, 'no-candidate', { ...common, candidateCount: 0, inRadiusCandidateCount: 0 });
	}

	const inRadius = candidates
		.map((candidate) => ({
			xPx: originXPx + candidate.xPx,
			yPx: originYPx + candidate.yPx,
			score: scoreOf(candidate)
		}))
		.filter((candidate) => Math.hypot(candidate.xPx - clickPx.xPx, candidate.yPx - clickPx.yPx) <= geometry.snapRadiusPx)
		.sort((left, right) => right.score - left.score);
	if (inRadius.length === 0) {
		return rejected(clickPx, 'outside-radius', {
			...common,
			candidateCount: candidates.length,
			inRadiusCandidateCount: 0
		});
	}
	const best = inRadius[0];
	const bestCandidateScore: LandmarkScore = {
		name: kind === 'basket' ? 'basket.templateNcc' : 'tee.detectorScore',
		value: best.score,
		higherIsBetter: true
	};
	if (best.score < LOCAL_SNAP_MIN_SCORE) {
		return rejected(clickPx, 'below-score', {
			...common,
			candidateCount: candidates.length,
			inRadiusCandidateCount: inRadius.length,
			bestCandidateScore
		});
	}

	const point = { xPx: best.xPx, yPx: best.yPx };
	return {
		point,
		trace: {
			attempted: true,
			accepted: true,
			clickPx,
			snappedPoint: point,
			candidateCount: candidates.length,
			inRadiusCandidateCount: inRadius.length,
			bestCandidateScore,
			...common
		}
	};
}

/**
 * Compatibility wrapper used by the staged worker. It deliberately keeps the
 * existing point|null API while making every attempt observable as one
 * structured console object, including exact rejection reason.
 */
export function localFeatureSnap(
	kind: LocalSnapKind,
	cv: LocalSnapCv,
	raster: LocalSnapRaster,
	clickPx: LocalSnapPoint,
	calibration: LocalSnapCalibration
): LocalSnapPoint | null {
	const outcome = localFeatureSnapDetailed(kind, cv, raster, clickPx, calibration);
	console.info('[ChainSpot CV local-snap]', outcome.trace);
	return outcome.point;
}

export { asUiScalePx, deriveCanonicalUiScalePx };
export type { UiScalePx, BasketTemplateScale };
