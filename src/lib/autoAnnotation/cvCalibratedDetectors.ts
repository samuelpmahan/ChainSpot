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
import { assessTeeBootstrap, proposeWeakTeeCandidates } from './teeBootstrapPolicy';
import type { TeeBadgeAnchor, TeeBootstrapResult } from './teeBootstrapPolicy';
import { findOccludedBasketMatch, basketRecoverySearchRadiusPx } from './basketOcclusionRecovery';
import type {
	BasketBadgeBox,
	BasketDistanceBand,
	BasketFallbackRaster,
	BasketFallbackTemplate
} from './basketOcclusionRecovery';
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

export interface CalibratedTeeBootstrapResult extends TeeBootstrapResult {
	/** Generic candidate pool assessed by the confidence ladder. */
	readonly candidates: readonly TeePadCandidate[];
}

function samePhysicalPad(a: TeePadCandidate, b: TeePadCandidate): boolean {
	const localMinor = Math.max(1, Math.min(a.widthPx, a.heightPx, b.widthPx, b.heightPx));
	return Math.hypot(a.xPx - b.xPx, a.yPx - b.yPx) <= localMinor * 0.45;
}

/**
 * Production clean-course tee bootstrap.
 *
 * Primary and occlusion-tolerant proposals are pooled once. Nothing is
 * searched around a particular hole and no candidate is promoted because a
 * previous global grammar assignment happened to be weak. The course-level
 * policy then derives pad world scale from the pool, measures each pad axis,
 * and emits AUTO / REVIEW / UNRESOLVED ownership against visible badges.
 *
 * Occluded-only proposals are deliberately weak appearance evidence, so they
 * can become REVIEW (the H3/H5 class) but cannot become AUTO from a lucky ray
 * intersection alone.
 */
export function detectCalibratedTeeBootstrap(
	cv: TeePadCv,
	raster: TeePadRaster,
	options: CalibratedTeePadDetectionOptions,
	badges: readonly TeeBadgeAnchor[]
): CalibratedTeeBootstrapResult {
	const primary = detectTeePadCandidates(cv, raster, options);
	const requested = options.maxCandidates ?? 18;
	const occluded = detectOccludedEdgeLoopCandidates(cv, raster, {
		...options,
		maxCandidates: Math.max(requested, requested * 2)
	}).candidates;
	const candidates: TeePadCandidate[] = [...primary];
	for (const candidate of occluded) {
		if (!candidates.some((existing) => samePhysicalPad(existing, candidate))) candidates.push(candidate);
	}
	let assessed = assessTeeBootstrap(raster, candidates, badges);
	if (assessed.calibration && assessed.counts.unresolved > 0) {
		const weak = proposeWeakTeeCandidates(raster, badges, assessed.calibration, assessed, candidates);
		for (const candidate of weak) {
			if (!candidates.some((existing) => samePhysicalPad(existing, candidate))) candidates.push(candidate);
		}
		if (weak.length > 0) assessed = assessTeeBootstrap(raster, candidates, badges);
	}
	return { candidates, ...assessed };
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

export interface BasketOcclusionFallbackBadge {
	readonly holeNumber: number;
	readonly xPx: number;
	readonly yPx: number;
}

export interface OccludedBasketCandidate extends CalibratedBasketCandidate {
	readonly holeNumber: number;
}

/**
 * A handful of samples close to the already-calibrated basket template
 * scale. `detectBasketCandidatesAtTemplateScale`'s own 9-sample 0.9..1.1
 * sweep exists because that scale is itself unknown at that point; here it
 * is already trusted (derived from the course's own successfully-matched
 * baskets), so the fallback only needs to absorb minor local size
 * variation, not rediscover scale from scratch -- fewer samples keeps the
 * manual (non-OpenCV) masked correlation affordable.
 */
const FALLBACK_SCALE_SAMPLE_COUNT = 5;
const FALLBACK_SCALE_RANGE_LOW = 0.9;
const FALLBACK_SCALE_RANGE_HIGH = 1.1;

function fallbackScaleSamples(basketTemplateScale: number): number[] {
	const samples: number[] = [];
	for (let index = 0; index < FALLBACK_SCALE_SAMPLE_COUNT; index += 1) {
		const fraction = index / (FALLBACK_SCALE_SAMPLE_COUNT - 1);
		samples.push(basketTemplateScale * (FALLBACK_SCALE_RANGE_LOW + fraction * (FALLBACK_SCALE_RANGE_HIGH - FALLBACK_SCALE_RANGE_LOW)));
	}
	return samples;
}

/**
 * Production occlusion-tolerant basket recovery. Mirrors
 * `detectCalibratedTeeBootstrap`'s split between "detect candidates" (this
 * function) and "decide ownership" (the caller's course-grammar pass): this
 * never touches `detectBasketCandidatesAtTemplateScale`'s own behavior, and
 * only ever searches the small ROI around each already-unresolved hole's own
 * badge -- never a full-image rescan. `unresolvedBadges` and `band` are
 * expected to come from a first course-grammar pass plus
 * `basketOcclusionRecovery.ts`'s course-derived distance-band classifier, so
 * this only ever runs for holes whose primary basket assignment already
 * looks implausible.
 */
export function detectCalibratedBasketOcclusionFallback(
	raster: BasketFallbackRaster,
	template: BasketFallbackTemplate,
	unresolvedBadges: readonly BasketOcclusionFallbackBadge[],
	occlusionBoxes: readonly BasketBadgeBox[],
	band: BasketDistanceBand,
	basketTemplateScale: BasketTemplateScale
): readonly OccludedBasketCandidate[] {
	if (unresolvedBadges.length === 0) return [];
	const searchRadiusPx = basketRecoverySearchRadiusPx(band);
	const templateScales = fallbackScaleSamples(basketTemplateScale);
	const recovered: OccludedBasketCandidate[] = [];
	for (const badge of unresolvedBadges) {
		const match = findOccludedBasketMatch(
			raster,
			template,
			badge.xPx,
			badge.yPx,
			searchRadiusPx,
			templateScales,
			occlusionBoxes
		);
		if (!match) continue;
		recovered.push({
			holeNumber: badge.holeNumber,
			xPx: match.xPx,
			yPx: match.yPx,
			widthPx: match.widthPx,
			heightPx: match.heightPx,
			score: match.score,
			scale: asBasketTemplateScale(
				match.widthPx / template.widthPx,
				'Occlusion-fallback basket candidate template scale'
			)
		});
	}
	return recovered;
}
