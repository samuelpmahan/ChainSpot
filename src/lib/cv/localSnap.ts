/**
 * Pure local tee/basket snap detector. The browser places the user's click
 * optimistically and this pass may settle it to a nearby feature.
 *
 * The important contract is now explicit: a snap is not just point|null.
 * `localFeatureSnapDetailed` records the first stage that rejected the click,
 * the candidate population, the real detector score, and the calibration
 * evidence used. `localFeatureSnap` remains the compatibility wrapper used by
 * existing callers/tests.
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
	/**
	 * Optional full-course evidence for the same local feature family. For tees
	 * this may widen the detector's geometry scale when the actual rendered pad
	 * is larger than badge-derived UiScale predicts. Baseline detection always
	 * still runs, so this cannot remove a candidate the old path found.
	 */
	readonly knownRecommendation?: LocalSnapKnownRecommendation;
}

export interface LocalSnapOutcome {
	readonly point: LocalSnapPoint | null;
	readonly trace: LocalSnapTrace;
}

export const TEE_PAD_MAX_FOOTPRINT_UI_SCALE_MULTIPLE = 26;
export const LOCAL_SNAP_CROP_FEATURE_MULTIPLE = 4;
export const LOCAL_SNAP_RADIUS_FEATURE_MULTIPLE = 0.5;
export const LOCAL_SNAP_MAX_ABSOLUTE_RADIUS_PX = 24;
export const LOCAL_SNAP_MIN_SCORE = 0.5;
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

function featureFootprintSourcePx(
	kind: LocalSnapKind,
	calibration: LocalSnapCalibration
): number | null {
	if (kind === 'tee') {
		const baseline = defaultTeeFootprint(calibration.uiScalePx);
		const measured = calibration.knownRecommendation?.featureFootprintPx;
		return finitePositive(measured) ? Math.max(baseline, measured) : baseline;
	}
	const basket = calibration.basket;
	if (!basket) return null;
	return Math.max(basket.template.widthPx, basket.template.heightPx) * basket.templateScale;
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
	const baselineOptions: CalibratedTeePadDetectionOptions = { uiScalePx: calibration.uiScalePx };
	const baseline = detectCalibratedTeePadCandidates(cv, cropped, baselineOptions);

	const measuredFootprint = calibration.knownRecommendation?.featureFootprintPx;
	if (!finitePositive(measuredFootprint)) return baseline;
	const measuredScale = measuredFootprint / TEE_PAD_MAX_FOOTPRINT_UI_SCALE_MULTIPLE;
	const ratio = measuredScale / calibration.uiScalePx;
	if (!(ratio > 1 + TEE_SCALE_EVIDENCE_MIN_DELTA)) return baseline;

	const evidenceScale = asUiScalePx(measuredScale, 'Full-course tee-footprint snap scale');
	const evidence = detectCalibratedTeePadCandidates(cv, cropped, { uiScalePx: evidenceScale });
	const merged = [...baseline];
	for (const candidate of evidence) {
		if (!merged.some((existing) => sameCandidate(existing, candidate))) merged.push(candidate);
	}
	return merged;
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
		trace: {
			attempted: true,
			accepted: false,
			rejectReason: reason,
			clickPx,
			...extra
		}
	};
}

function scoreOf(candidate: { readonly score?: number }): number {
	return candidate.score ?? -Infinity;
}

/**
 * Detailed local-snap pass. Failure is still a normal result, but it no
 * longer collapses every cause into an uninspectable `null`.
 */
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

	const footprintPx = featureFootprintSourcePx(kind, calibration);
	if (footprintPx === null || !(footprintPx > 0)) return rejected(clickPx, 'no-footprint');
	const snapRadiusPx = Math.min(
		footprintPx * LOCAL_SNAP_RADIUS_FEATURE_MULTIPLE,
		LOCAL_SNAP_MAX_ABSOLUTE_RADIUS_PX
	);
	const known = calibration.knownRecommendation;
	const knownDistance = known ? Math.hypot(known.point.xPx - clickPx.xPx, known.point.yPx - clickPx.yPx) : undefined;
	const common: Partial<LocalSnapTrace> = {
		featureFootprintPx: footprintPx,
		snapRadiusPx,
		calibrationSource:
			kind === 'tee' && finitePositive(known?.featureFootprintPx)
				? 'number-badge-ui-scale+full-course-tee-footprint'
				: 'number-badge-ui-scale',
		...(knownDistance === undefined
			? {}
			: {
				knownRecommendationDistancePx: knownDistance,
				knownRecommendationInRadius: knownDistance <= snapRadiusPx
			})
	};

	const bounds = computeCropBounds(
		raster,
		clickPx,
		footprintPx * LOCAL_SNAP_CROP_FEATURE_MULTIPLE
	);
	if (!bounds) return rejected(clickPx, 'empty-crop', common);
	if ((kind === 'tee' && !raster.rgba) || (kind === 'basket' && !raster.gray)) {
		return rejected(clickPx, 'missing-raster-channel', common);
	}

	const originXPx = bounds.x0 * raster.sourceScale;
	const originYPx = bounds.y0 * raster.sourceScale;
	const candidates =
		kind === 'tee'
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
		.filter((candidate) => Math.hypot(candidate.xPx - clickPx.xPx, candidate.yPx - clickPx.yPx) <= snapRadiusPx)
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

/** Compatibility wrapper: existing UI behavior remains point-or-null. */
export function localFeatureSnap(
	kind: LocalSnapKind,
	cv: LocalSnapCv,
	raster: LocalSnapRaster,
	clickPx: LocalSnapPoint,
	calibration: LocalSnapCalibration
): LocalSnapPoint | null {
	return localFeatureSnapDetailed(kind, cv, raster, clickPx, calibration).point;
}

export { asUiScalePx, deriveCanonicalUiScalePx };
export type { UiScalePx, BasketTemplateScale };
