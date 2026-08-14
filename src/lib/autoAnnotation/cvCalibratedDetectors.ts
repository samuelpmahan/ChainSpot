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
	deriveBasketIconMasksPx,
	derivePuttingCircleMasksPx,
	deriveWalkingPathMasksPx,
	detectDashedPathChains,
	detectOccludedEdgeLoopCandidates,
	detectTeePadCandidates,
	detectTeePadVariants
} from './teePadDetection';
import type {
	OccludedEdgeLoopResult,
	PuttingCircleSourceBasket,
	TeeCandidateTier,
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
	asNumberTemplateScale,
	asUiScalePx
} from './cvCalibration';
import type {
	BasketTemplateScale,
	NumberTemplateScale,
	UiScalePx
} from './cvCalibration';
import { measureWorldScale, resizeRgbaArea } from './worldScale';
import type { WorldScaleMeasurement } from './worldScale';
import { deduplicatePhysicalTeePads } from './teePhysicalDedup';

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
	/** Deduplicated physical-pad pool assessed by the confidence ladder. */
	readonly candidates: readonly TeePadCandidate[];
	/** All tier outputs before physical-pad NMS; diagnostics only. */
	readonly rawCandidates: readonly TeePadCandidate[];
	readonly dedupClusters: readonly (readonly number[])[];
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
/**
 * Levers for detection ideas that are safe but not (yet) proven to help --
 * see `docs/deferred-detection-experiments.md`. Every flag defaults to off,
 * so omitting this parameter reproduces exactly the production pipeline's
 * behavior; passing one on is how a fixture re-test happens without
 * resurrecting a diff from git history first. `scripts/detect-course.ts`
 * exposes these as CLI flags for that purpose.
 */
export interface TeeBootstrapExperiments {
	/**
	 * Fold dashed walking/cart-path chains (`detectDashedPathChains`) into
	 * the tier-3 occlusion-masking pool alongside the putting-circle/
	 * basket-icon masks. Tested against GoldenTeeSet and Alex Clark:
	 * `correctHoles` identical with and without on both, including the
	 * path-adjacent hole that motivated it -- safe, but no measured benefit
	 * yet. See the "Dashed walking/cart-path detector" entry in
	 * `docs/deferred-detection-experiments.md`.
	 */
	readonly walkingPathMasking?: boolean;
}

export function detectCalibratedTeeBootstrap(
	cv: TeePadCv,
	raster: TeePadRaster,
	options: CalibratedTeePadDetectionOptions,
	badges: readonly TeeBadgeAnchor[],
	baskets: readonly PuttingCircleSourceBasket[] = [],
	experiments: TeeBootstrapExperiments = {}
): CalibratedTeeBootstrapResult {
	const withTier = (candidate: TeePadCandidate, tier: TeeCandidateTier): TeePadCandidate => ({
		...candidate,
		provenance: candidate.support.map((support) => ({ tier, support }))
	});
	const primary = detectTeePadCandidates(cv, raster, options).map((candidate) => withTier(candidate, 'primary'));
	const requested = options.maxCandidates ?? 18;
	const occluded = detectOccludedEdgeLoopCandidates(cv, raster, {
		...options,
		maxCandidates: Math.max(requested, requested * 2)
	}).candidates.map((candidate) => withTier(candidate, 'occluded'));
	// Detector-local NMS has already happened inside each detector. Cross-tier
	// hypotheses remain raw here so one explicit physical-pad NMS stage below
	// owns all primary/recovery deduplication and can retain provenance.
	const candidates: TeePadCandidate[] = [...primary, ...occluded];
	let assessed = assessTeeBootstrap(raster, candidates, badges);
	if (assessed.calibration && assessed.counts.unresolved > 0) {
		const weak = proposeWeakTeeCandidates(raster, badges, assessed.calibration, assessed, candidates)
			.map((candidate) => withTier(candidate, 'weak-template'));
		candidates.push(...weak);
		if (weak.length > 0) assessed = assessTeeBootstrap(raster, candidates, badges);
	}

	// A neighboring hole's dashed putting circle can cross a tee pad's own
	// edge and break the rectangle the occluded-edge-loop detector looks for
	// (the "H3" case: hole 3's pad partly erased by hole 5's putting circle).
	// Masking every putting circle globally, up front, was tried and
	// rejected: it perturbs the whole candidate pool and the pad-size
	// calibration derived from it, occasionally erasing a *different* real
	// pad's own evidence and turning a correct hole into a missing one. This
	// only ever runs for holes still not AUTO after every existing tier above
	// -- an already-resolved hole's candidates and assignment are completely
	// untouched, so this cannot regress a hole that already works.
	const stillNotAuto = assessed.holes.filter((hole) => hole.decision !== 'auto');
	if (stillNotAuto.length > 0) {
		const occlusionMasks = [
			...(baskets.length > 0 ? derivePuttingCircleMasksPx(raster, baskets, options.uiScalePx) : []),
			...(baskets.length > 0 ? deriveBasketIconMasksPx(baskets, options.uiScalePx) : []),
			...(experiments.walkingPathMasking
				? deriveWalkingPathMasksPx(detectDashedPathChains(cv, raster, options), options.uiScalePx)
				: [])
		];
		if (occlusionMasks.length > 0) {
			const recovered = detectOccludedEdgeLoopCandidates(cv, raster, {
				...options,
				ignoreCirclesPx: occlusionMasks,
				maxCandidates: Math.max(requested, requested * 2)
			}).candidates.map((candidate) => withTier(candidate, 'masked-recovery'));
			// Masked recovery is still appearance generation. Do not choose the
			// nearest result per badge here; that would mix ownership into detection.
			candidates.push(...recovered);
			if (recovered.length > 0) assessed = assessTeeBootstrap(raster, candidates, badges);
		}
	}

	// Recovery tiers intentionally over-generate. Collapse physical pads only
	// after every appearance tier has run, before semantic ownership. This is
	// geometric NMS, not a top-18 policy.
	const clusters = deduplicatePhysicalTeePads(candidates);
	const deduped = clusters.map((cluster) => cluster.candidate);
	assessed = assessTeeBootstrap(raster, deduped, badges);
	return {
		candidates: deduped,
		rawCandidates: candidates,
		dedupClusters: clusters.map((cluster) => cluster.sourceIndexes),
		...assessed
	};
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

/**
 * The UI scale the tee constants were tuned at (IMG_5641). In the canonical
 * tee workspace, pads are resized to exactly that regime's world size, so
 * the frozen constants (`X / 1.77 * uiScalePx`) evaluate to their tuned
 * source-pixel values when this scale is passed. Validated end-to-end in
 * scripts/cv-probes/white-rect-scale-findings.md.
 */
const CANONICAL_TEE_UI_SCALE = 1.77;
/**
 * worldScale this close to 1 runs the existing path untouched — IMG_5641
 * and same-zoom captures reproduce today's behavior bit-for-bit, and the
 * synthetic scale-sweep guardrail keeps covering the coupled-scale case.
 */
const WORLD_SCALE_PASSTHROUGH_BAND = 0.12;

export interface WorldNormalizedTeeBootstrapResult extends CalibratedTeeBootstrapResult {
	/** Null when no white-frame measurement was possible (fallback: native path ran). */
	readonly worldScaleMeasurement: WorldScaleMeasurement | null;
	/** True when the tee stage actually ran in the canonical workspace. */
	readonly normalized: boolean;
}

/**
 * World-normalized tee bootstrap: the production entry point for tee
 * detection on captures whose map zoom differs from the tuned regime.
 *
 * Pipeline position (see white-rect-scale-findings.md): UI-semantic
 * detection (badges, baskets) has already run on the NATIVE raster; this
 * stage privately builds a canonical tee workspace — the raster resized so
 * pad frames match IMG_5641's measured size — runs the frozen tee detector
 * there, and maps every candidate back to native pixels. Canonicalization
 * never leaks: callers put native coordinates in and get native coordinates
 * out, and nothing else in the pipeline sees the resized raster.
 *
 * Falls back to the existing native-raster path when the white-frame
 * measurement finds too few pads, when worldScale is within the
 * passthrough band of 1, or when normalization would UPSCALE (worldScale
 * < 1 means the capture is zoomed further out than the tuned regime;
 * inventing detail via upscale is worse than the current behavior).
 */
export function detectWorldNormalizedTeeBootstrap(
	cv: TeePadCv,
	raster: TeePadRaster,
	options: CalibratedTeePadDetectionOptions,
	badges: readonly TeeBadgeAnchor[],
	baskets: readonly PuttingCircleSourceBasket[] = [],
	experiments: TeeBootstrapExperiments = {}
): WorldNormalizedTeeBootstrapResult {
	const measurement = measureWorldScale({
		rgba: raster.rgba,
		widthPx: raster.widthPx,
		heightPx: raster.heightPx
	});

	// SPIKE: the scale pass already found white rectangular tee-pad frames.
	// Try those exact objects before paying for primary + Hough + recovery.
	// Only short-circuit if they account for every visible badge with zero
	// unresolved ownership; otherwise the existing detector runs unchanged.
	//
	// For this local spike, mark frame proposals as dual-support so the
	// existing bootstrap policy treats the compound white-frame gate as
	// strong appearance evidence without plumbing a new production support
	// enum yet. If this wins, formalize `white-frame` provenance afterward.
	const whiteFrameCandidates: TeePadCandidate[] = (measurement?.frameCandidates ?? []).map((frame) => ({
		xPx: frame.xPx,
		yPx: frame.yPx,
		orientationDeg: frame.orientationDeg,
		widthPx: frame.majorPx,
		heightPx: frame.minorPx,
		score: 1,
		support: ['gray-center', 'edge-loop']
	}));
	const targetCount = Math.min(options.maxCandidates ?? badges.length, badges.length);
	if (targetCount > 0 && whiteFrameCandidates.length >= targetCount) {
		const frameClusters = deduplicatePhysicalTeePads(whiteFrameCandidates);
		const dedupedFrames = frameClusters.map((cluster) => cluster.candidate);
		const frameAssessment = assessTeeBootstrap(raster, dedupedFrames, badges);
		if (
			frameAssessment.counts.unresolved === 0 &&
			frameAssessment.assignments.length >= targetCount
		) {
			return {
				candidates: dedupedFrames,
				rawCandidates: whiteFrameCandidates,
				dedupClusters: frameClusters.map((cluster) => cluster.sourceIndexes),
				...frameAssessment,
				worldScaleMeasurement: measurement,
				normalized: false
			};
		}
	}

	const worldScale = measurement?.worldScale ?? null;
	if (
		worldScale === null ||
		Math.abs(worldScale - 1) <= WORLD_SCALE_PASSTHROUGH_BAND ||
		worldScale < 1
	) {
		return {
			...detectCalibratedTeeBootstrap(cv, raster, options, badges, baskets, experiments),
			worldScaleMeasurement: measurement,
			normalized: false
		};
	}

	const factor = 1 / worldScale;
	const resized = resizeRgbaArea(
		{ rgba: raster.rgba, widthPx: raster.widthPx, heightPx: raster.heightPx },
		factor
	);
	const scalePoint = <T extends { readonly xPx: number; readonly yPx: number }>(point: T, s: number): T => ({
		...point,
		xPx: point.xPx * s,
		yPx: point.yPx * s
	});
	const normalizedBadges = badges.map((badge) => ({
		...scalePoint(badge, factor),
		...(badge.widthPx !== undefined ? { widthPx: badge.widthPx * factor } : {}),
		...(badge.heightPx !== undefined ? { heightPx: badge.heightPx * factor } : {})
	}));
	const normalizedBaskets = baskets.map((basket) => scalePoint(basket, factor));
	const normalizedBounds = options.mapBoundsPx
		? { topPx: options.mapBoundsPx.topPx * factor, bottomPx: options.mapBoundsPx.bottomPx * factor }
		: undefined;
	const result = detectCalibratedTeeBootstrap(
		cv,
		{ rgba: resized.rgba, widthPx: resized.widthPx, heightPx: resized.heightPx, sourceScale: raster.sourceScale },
		{
			...options,
			uiScalePx: asUiScalePx(CANONICAL_TEE_UI_SCALE, 'canonical tee workspace'),
			...(normalizedBounds ? { mapBoundsPx: normalizedBounds } : {})
		},
		normalizedBadges,
		normalizedBaskets,
		experiments
	);

	// Map every coordinate-bearing output back to native pixels. `holes`,
	// `calibration`, and `rejectedCandidateIndexes` stay in workspace units:
	// they are diagnostics of the normalized run, and nothing downstream
	// consumes their coordinates (the worker reads candidates, assignments,
	// and counts only).
	const backToNative = (candidate: TeePadCandidate): TeePadCandidate => ({
		...candidate,
		xPx: candidate.xPx * worldScale,
		yPx: candidate.yPx * worldScale,
		widthPx: candidate.widthPx * worldScale,
		heightPx: candidate.heightPx * worldScale
	});
	const nativeRawCandidates = result.rawCandidates.map(backToNative);
	const nativeClusters = deduplicatePhysicalTeePads(nativeRawCandidates);
	const nativeCandidates = nativeClusters.map((cluster) => cluster.candidate);
	// Ownership is deliberately recomputed against native badge coordinates
	// after native-coordinate NMS. Appearance scores still come from the
	// canonical detector; badge geometry never creates a candidate.
	const nativeAssessment = assessTeeBootstrap(raster, nativeCandidates, badges);
	return {
		...result,
		...nativeAssessment,
		candidates: nativeCandidates,
		rawCandidates: nativeRawCandidates,
		dedupClusters: nativeClusters.map((cluster) => cluster.sourceIndexes),
		worldScaleMeasurement: measurement,
		normalized: true
	};
}
