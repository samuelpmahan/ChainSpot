import { detectHoleNumberBadges } from './holeNumberDetection';
import type {
	HoleNumberCandidate,
	HoleNumberCvModule,
	HoleNumberDetection,
	HoleNumberDetectionOptions,
	HoleNumberRaster,
	HoleNumberScaleAnchor,
	HoleNumberTemplate
} from './holeNumberDetection';
import {
	detectBasketTemplateCandidates,
	findBasketAnchorScale
} from './basketTemplateDetection';
import type {
	BasketCandidate as RawBasketCandidate,
	BasketCv,
	BasketDetectionOptions as RawBasketDetectionOptions,
	BasketRaster,
	BasketTemplateRaster,
	FindBasketAnchorScaleOptions
} from './basketTemplateDetection';
import {
	detectOccludedEdgeLoopCandidates,
	detectTeePadCandidates,
	detectTeePadVariants
} from './teePadDetection';
import type {
	OccludedEdgeLoopResult,
	TeePadCandidate,
	TeePadCv,
	TeePadDetectionOptions as RawTeePadDetectionOptions,
	TeePadRaster,
	TeePadVariant,
	TeePadVariantResult
} from './teePadDetection';
import {
	asBasketTemplateScale,
	asNumberTemplateScale
} from './cvCalibration';
import type {
	BasketTemplateScale,
	NumberTemplateScale,
	UiScalePx
} from './cvCalibration';

export type CalibratedHoleNumberScaleAnchor = Omit<HoleNumberScaleAnchor, 'scale'> & {
	readonly scale: NumberTemplateScale;
};

export type CalibratedHoleNumberCandidate = Omit<HoleNumberCandidate, 'scale'> & {
	readonly scale: NumberTemplateScale;
};

export type CalibratedHoleNumberDetection = Omit<HoleNumberDetection, 'anchor' | 'candidates'> & {
	readonly anchor: CalibratedHoleNumberScaleAnchor | null;
	readonly candidates: readonly CalibratedHoleNumberCandidate[];
};

/**
 * Brands the template-matching scale at the detector boundary. This is not a
 * UDisc UI scale and must never be passed to geometry that expects UiScalePx.
 */
export function detectCalibratedHoleNumberBadges(
	cv: HoleNumberCvModule,
	source: HoleNumberRaster,
	templates: readonly HoleNumberTemplate[],
	options: HoleNumberDetectionOptions = {}
): CalibratedHoleNumberDetection {
	const detection = detectHoleNumberBadges(cv, source, templates, options);
	return {
		...detection,
		anchor: detection.anchor
			? {
					...detection.anchor,
					scale: asNumberTemplateScale(detection.anchor.scale, 'Hole-number template scale')
				}
			: null,
		candidates: detection.candidates.map((candidate) => ({
			...candidate,
			scale: asNumberTemplateScale(candidate.scale, 'Hole-number candidate template scale')
		}))
	};
}

export interface CalibratedTeePadDetectionOptions
	extends Omit<RawTeePadDetectionOptions, 'uiScalePx'> {
	readonly uiScalePx: UiScalePx;
}

export function detectCalibratedTeePadCandidates(
	cv: TeePadCv,
	raster: TeePadRaster,
	options: CalibratedTeePadDetectionOptions
): readonly TeePadCandidate[] {
	return detectTeePadCandidates(cv, raster, options);
}

export function detectCalibratedTeePadVariants(
	cv: TeePadCv,
	raster: TeePadRaster,
	options: CalibratedTeePadDetectionOptions,
	variants: readonly TeePadVariant[]
): readonly TeePadVariantResult[] {
	return detectTeePadVariants(cv, raster, options, variants);
}

export function detectCalibratedOccludedEdgeLoopCandidates(
	cv: TeePadCv,
	raster: TeePadRaster,
	options: CalibratedTeePadDetectionOptions
): OccludedEdgeLoopResult {
	return detectOccludedEdgeLoopCandidates(cv, raster, options);
}

const DEFAULT_GAP_FALLBACK_RADIUS_UI_SCALE_MULTIPLE = 40;
const DEFAULT_GAP_FALLBACK_SCORE_FLOOR = 0.7;
const GAP_FALLBACK_MAX_CANDIDATES = 80;

export interface TeeGapFallbackOptions extends CalibratedTeePadDetectionOptions {
	/** Search radius from the badge, in uiScalePx multiples. Defaults to 40. */
	readonly radiusUiScaleMultiple?: number;
	/** Minimum occluded-edge-loop score to accept a fallback candidate. Defaults to 0.7. */
	readonly fallbackScoreFloor?: number;
}

/**
 * Recovers a tee for a hole whose number badge has no confident primary
 * candidate (`gray-center`/`edge-loop`) nearby -- typically because a bright
 * dashed putting-circle stroke crosses the pad and outcompetes its own
 * low-contrast edge for `edge-loop`'s contour, or skews `gray-center`'s
 * narrow interior-brightness band. `occluded-edge-loop` tolerates a broken
 * rectangle (it pairs short rail segments instead of requiring one closed
 * loop), so it is used here strictly as a *fallback*: called only for the
 * badges the caller has already identified as gapped (e.g. via
 * `associateCourseGrammar`'s `weak-tee-confidence` failures), and gated by a
 * tight radius plus a high score floor so a low-confidence guess can never
 * outrank a real primary candidate elsewhere on the course. Validated
 * against `resources/GoldenTeeSet.chainspot.zip`: recovers a genuinely
 * gapped hole while leaving all previously-correct holes unchanged, whereas
 * fusing `occluded-edge-loop` into every hole's detection (no badge
 * targeting, no score floor) let one unrelated high-scoring false positive
 * outcompete a real primary candidate elsewhere on the course.
 */
export function detectCalibratedTeeGapFallbackCandidates(
	cv: TeePadCv,
	raster: TeePadRaster,
	options: TeeGapFallbackOptions,
	gappedBadges: readonly Readonly<{ xPx: number; yPx: number }>[]
): readonly TeePadCandidate[] {
	if (gappedBadges.length === 0) return [];
	const radiusPx = (options.radiusUiScaleMultiple ?? DEFAULT_GAP_FALLBACK_RADIUS_UI_SCALE_MULTIPLE) * options.uiScalePx;
	const scoreFloor = options.fallbackScoreFloor ?? DEFAULT_GAP_FALLBACK_SCORE_FLOOR;
	const occluded = detectOccludedEdgeLoopCandidates(cv, raster, { ...options, maxCandidates: GAP_FALLBACK_MAX_CANDIDATES }).candidates;
	const extras: TeePadCandidate[] = [];
	for (const badge of gappedBadges) {
		const nearby = occluded
			.filter((candidate) => candidate.score >= scoreFloor && Math.hypot(candidate.xPx - badge.xPx, candidate.yPx - badge.yPx) <= radiusPx)
			.sort((a, b) => b.score - a.score);
		if (nearby[0]) extras.push(nearby[0]);
	}
	return extras;
}

export type CalibratedBasketCandidate = Omit<RawBasketCandidate, 'scale'> & {
	/** Basket-template multiplier, never a hole-number multiplier or canonical UDisc UiScalePx. */
	readonly scale: BasketTemplateScale;
};

export interface BasketTemplateScaleDetectionOptions
	extends Omit<RawBasketDetectionOptions, 'uiScalePx' | 'templateScales'> {
	readonly templateScale: BasketTemplateScale;
	readonly templateScales?: readonly BasketTemplateScale[];
}

/**
 * Typed adapter around the proven basket detector. Its low-level historical
 * `uiScalePx` option is actually a basket-template multiplier; this adapter
 * removes that misleading name from every guarded/production call site.
 */
export function detectBasketCandidatesAtTemplateScale(
	cv: BasketCv,
	raster: BasketRaster,
	template: BasketTemplateRaster,
	options: BasketTemplateScaleDetectionOptions
): readonly CalibratedBasketCandidate[] {
	const { templateScale, templateScales, ...rest } = options;
	const rawOptions: RawBasketDetectionOptions = {
		...rest,
		uiScalePx: templateScale,
		templateScales
	};
	return detectBasketTemplateCandidates(cv, raster, template, rawOptions).map((candidate) => ({
		...candidate,
		scale: asBasketTemplateScale(candidate.scale, 'Basket candidate template scale')
	}));
}

export interface CalibratedBasketAnchorScale {
	readonly scale: BasketTemplateScale;
	readonly score: number;
}

export function findCalibratedBasketAnchorScale(
	cv: BasketCv,
	raster: BasketRaster,
	template: BasketTemplateRaster,
	options: FindBasketAnchorScaleOptions = {}
): CalibratedBasketAnchorScale | null {
	const anchor = findBasketAnchorScale(cv, raster, template, options);
	return anchor
		? { ...anchor, scale: asBasketTemplateScale(anchor.scale, 'Basket anchor template scale') }
		: null;
}
