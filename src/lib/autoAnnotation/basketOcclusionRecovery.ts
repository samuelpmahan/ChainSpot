/**
 * Occlusion-tolerant basket recovery fallback.
 *
 * Mirrors the tee-bootstrap philosophy (`teeBootstrapPolicy.ts`): the primary
 * basket template-matcher (`basketTemplateDetection.ts`) is never touched or
 * weakened. This module only answers two questions about a hole whose
 * primary-detection + course-grammar basket assignment already looks
 * implausible:
 *
 *   1. how far can this course's own baskets plausibly sit from their own
 *      number badge? Learned from the holes that DID get a trustworthy
 *      primary assignment -- never a fixed pixel constant, never tuned to
 *      one fixture.
 *   2. within that learned radius around the hole's own badge -- never a
 *      full-image rescan -- does MASKED template correlation, which ignores
 *      every pixel that falls under any number badge's bounding box, find
 *      surviving basket-shaped evidence?
 *
 * A masked match is deliberately never treated as full-strength evidence: a
 * badge can render squarely on top of a real basket glyph (the motivating
 * case: hole 9's basket on `resources/real-capture/Lenard.PNG`, occluded by
 * a *different* hole's number badge rendered nearby -- which is exactly why
 * the mask excludes every badge's box, not just the hole's own), leaving
 * only a fragment -- a cage shoulder, the stem, a chain notch -- outside the
 * badge rectangle. That fragment can be enough to relocate the basket, but
 * it is never enough to claim the same confidence as an unoccluded match, so
 * callers must treat every recovered candidate as REVIEW, never AUTO.
 */

export interface BasketBadgeBox {
	readonly xPx: number;
	readonly yPx: number;
	readonly widthPx: number;
	readonly heightPx: number;
}

export interface BasketRecoveryHoleSample {
	readonly holeNumber: number;
	/** Distance from this hole's own badge to its primary-detection + grammar basket assignment. */
	readonly distancePx: number;
	/** True when that assignment is trustworthy enough to help learn this course's badge-to-basket geometry. */
	readonly trusted: boolean;
}

export interface BasketDistanceBand {
	readonly lowPx: number;
	readonly highPx: number;
}

/** Narrow, structural subset of `CourseGrammarResult` -- avoids a hard dependency on `courseGrammar.ts`'s full shape. */
export interface BasketRecoveryGrammarHole {
	readonly number: number;
	readonly numberBadge?: unknown;
	readonly basket?: { readonly distancePx: number; readonly detectorConfidence: number };
	readonly failures: readonly { readonly kind: string }[];
}

const TRUSTED_MIN_DETECTOR_CONFIDENCE = 0.5;

/**
 * Turns one course-grammar pass into the samples `deriveBasketDistanceBand`
 * and `findUnresolvedBasketHoles` need. A hole's basket only helps *learn*
 * the course's geometry (is `trusted`) when it wasn't already flagged as
 * ambiguous or polarity-conflicted by grammar itself -- those are a
 * different, already-diagnosed class of issue (real course geometry /
 * near-tie Hungarian assignment), not the occlusion this module targets.
 */
export function basketRecoverySamplesFromGrammar(
	holes: readonly BasketRecoveryGrammarHole[]
): readonly BasketRecoveryHoleSample[] {
	const samples: BasketRecoveryHoleSample[] = [];
	for (const hole of holes) {
		if (!hole.numberBadge || !hole.basket) continue;
		const trusted =
			hole.basket.detectorConfidence >= TRUSTED_MIN_DETECTOR_CONFIDENCE &&
			!hole.failures.some((failure) => failure.kind === 'ambiguous-basket' || failure.kind === 'basket-polarity-conflict');
		samples.push({ holeNumber: hole.number, distancePx: hole.basket.distancePx, trusted });
	}
	return samples;
}

const MIN_TRUSTED_SAMPLES = 4;
const BAND_LOW_MARGIN = 0.7;
const BAND_HIGH_MARGIN = 1.4;
const SEARCH_RADIUS_MARGIN = 1.15;
const MIN_SEARCH_RADIUS_PX = 60;

function percentile(sorted: readonly number[], fraction: number): number | undefined {
	if (sorted.length === 0) return undefined;
	const index = Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * fraction)));
	return sorted[index];
}

/**
 * Learns a plausible badge-to-basket distance band from this course's own
 * trustworthy primary assignments. Returns undefined when there is not
 * enough trustworthy course data to learn from (too small/atypical a
 * course), in which case no fallback should run at all -- mirrors
 * `deriveTeeSweepCalibration`'s "not enough course data" bailout.
 */
export function deriveBasketDistanceBand(
	samples: readonly BasketRecoveryHoleSample[]
): BasketDistanceBand | undefined {
	const trusted = samples
		.filter((sample) => sample.trusted && Number.isFinite(sample.distancePx))
		.map((sample) => sample.distancePx);
	if (trusted.length < MIN_TRUSTED_SAMPLES) return undefined;
	const sorted = [...trusted].sort((a, b) => a - b);
	const low = percentile(sorted, 0.1);
	const high = percentile(sorted, 0.9);
	if (low === undefined || high === undefined) return undefined;
	const lowPx = low * BAND_LOW_MARGIN;
	return { lowPx, highPx: Math.max(lowPx, high * BAND_HIGH_MARGIN) };
}

/**
 * Flags holes whose primary-detection + course-grammar basket assignment
 * distance falls outside the course-learned band: genuinely implausible,
 * not merely a locally ambiguous but geometrically ordinary match (that
 * class of ambiguity is real course geometry / a Hungarian-assignment
 * near-tie, and is out of scope for this occlusion-specific fallback).
 */
export function findUnresolvedBasketHoles(
	samples: readonly BasketRecoveryHoleSample[],
	band: BasketDistanceBand
): ReadonlySet<number> {
	const unresolved = new Set<number>();
	for (const sample of samples) {
		if (!Number.isFinite(sample.distancePx) || sample.distancePx < band.lowPx || sample.distancePx > band.highPx) {
			unresolved.add(sample.holeNumber);
		}
	}
	return unresolved;
}

/** Search radius around an unresolved hole's own badge -- never a full-image rescan. */
export function basketRecoverySearchRadiusPx(band: BasketDistanceBand): number {
	return Math.max(MIN_SEARCH_RADIUS_PX, band.highPx * SEARCH_RADIUS_MARGIN);
}

export interface BasketLikeCandidate {
	readonly xPx: number;
	readonly yPx: number;
	readonly widthPx: number;
	readonly heightPx: number;
}

/**
 * Mirrors `cvCalibratedDetectors.ts`'s `samePhysicalPad` tee dedup, adapted
 * to baskets: true when two candidates are almost certainly the same
 * physical basket rather than two distinct nearby baskets. Callers use this
 * to keep a recovered candidate out of the pool when the primary detector
 * already found the same basket (so the fallback only ever adds genuinely
 * new evidence, never a near-duplicate of an existing one).
 */
export function isSameBasketCandidate(a: BasketLikeCandidate, b: BasketLikeCandidate): boolean {
	const localMinor = Math.max(1, Math.min(a.widthPx, a.heightPx, b.widthPx, b.heightPx));
	return Math.hypot(a.xPx - b.xPx, a.yPx - b.yPx) <= localMinor * 0.45;
}

export interface BasketFallbackRaster {
	readonly gray: Uint8Array;
	readonly widthPx: number;
	readonly heightPx: number;
}

export interface BasketFallbackTemplate {
	readonly gray: Uint8Array;
	readonly widthPx: number;
	readonly heightPx: number;
}

export interface OccludedBasketMatch {
	/** Semantic point matching `BasketCandidate`: glyph-center x, stem-base y. */
	readonly xPx: number;
	readonly yPx: number;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly score: number;
	readonly trustedFraction: number;
}

/** Matches `basketTemplateDetection.ts`'s stem-base semantic point exactly, so recovered candidates behave identically downstream. */
const BASKET_BASE_Y_FRACTION = 0.96;
/** A rectangular badge box occludes its full extent, not just glyph edges, so the mask needs only a small anti-aliasing margin. */
const OCCLUSION_MASK_MARGIN_PX = 2;
/** A masked match must still cover a meaningful share of the template; below this, "evidence" is really just noise. */
export const MIN_TRUSTED_FRACTION = 0.2;
/** Deliberately not the primary detector's 0.5 floor re-used verbatim: this is a different statistic (masked correlation over a
 *  restricted, already-occlusion-narrowed pixel set), scoped to a small ROI, so a same-shaped score means something different here. */
export const MIN_MASKED_SCORE = 0.5;
const COARSE_STRIDE_PX = 6;
const REFINE_STRIDE_PX = 2;
const REFINE_RADIUS_PX = COARSE_STRIDE_PX * 2;

interface MaskedRoi {
	readonly x0: number;
	readonly y0: number;
	readonly width: number;
	readonly height: number;
	readonly gray: Uint8Array;
	readonly trusted: Uint8Array;
}

function buildMaskedRoi(
	raster: BasketFallbackRaster,
	centerXPx: number,
	centerYPx: number,
	halfSizePx: number,
	occlusionBoxes: readonly BasketBadgeBox[]
): MaskedRoi | undefined {
	const x0 = Math.max(0, Math.floor(centerXPx - halfSizePx));
	const y0 = Math.max(0, Math.floor(centerYPx - halfSizePx));
	const x1 = Math.min(raster.widthPx - 1, Math.ceil(centerXPx + halfSizePx));
	const y1 = Math.min(raster.heightPx - 1, Math.ceil(centerYPx + halfSizePx));
	const width = x1 - x0 + 1;
	const height = y1 - y0 + 1;
	if (width <= 0 || height <= 0) return undefined;

	const gray = new Uint8Array(width * height);
	for (let y = 0; y < height; y += 1) {
		const sourceRow = (y0 + y) * raster.widthPx + x0;
		gray.set(raster.gray.subarray(sourceRow, sourceRow + width), y * width);
	}

	const trusted = new Uint8Array(width * height);
	trusted.fill(1);
	for (const box of occlusionBoxes) {
		const left = Math.floor(box.xPx - box.widthPx / 2 - OCCLUSION_MASK_MARGIN_PX) - x0;
		const right = Math.ceil(box.xPx + box.widthPx / 2 + OCCLUSION_MASK_MARGIN_PX) - x0;
		const top = Math.floor(box.yPx - box.heightPx / 2 - OCCLUSION_MASK_MARGIN_PX) - y0;
		const bottom = Math.ceil(box.yPx + box.heightPx / 2 + OCCLUSION_MASK_MARGIN_PX) - y0;
		const clampedLeft = Math.max(0, left);
		const clampedRight = Math.min(width - 1, right);
		if (clampedLeft > clampedRight) continue;
		for (let y = Math.max(0, top); y <= Math.min(height - 1, bottom); y += 1) {
			trusted.fill(0, y * width + clampedLeft, y * width + clampedRight + 1);
		}
	}
	return { x0, y0, width, height, gray, trusted };
}

/** Nearest-neighbor resize: adequate for a masked correlation match, not a rendering -- the primary detector's `cv.resize` handles the real (unmasked) match quality. */
function resizeGrayTemplate(template: BasketFallbackTemplate, scale: number): BasketFallbackTemplate {
	const widthPx = Math.max(4, Math.round(template.widthPx * scale));
	const heightPx = Math.max(4, Math.round(template.heightPx * scale));
	const gray = new Uint8Array(widthPx * heightPx);
	const xRatio = template.widthPx / widthPx;
	const yRatio = template.heightPx / heightPx;
	for (let y = 0; y < heightPx; y += 1) {
		const sourceY = Math.min(template.heightPx - 1, Math.floor((y + 0.5) * yRatio));
		for (let x = 0; x < widthPx; x += 1) {
			const sourceX = Math.min(template.widthPx - 1, Math.floor((x + 0.5) * xRatio));
			gray[y * widthPx + x] = template.gray[sourceY * template.widthPx + sourceX];
		}
	}
	return { gray, widthPx, heightPx };
}

function maskedNccAt(
	roi: MaskedRoi,
	template: BasketFallbackTemplate,
	leftPx: number,
	topPx: number
): { score: number; trustedFraction: number } | undefined {
	const w = template.widthPx;
	const h = template.heightPx;
	if (leftPx < 0 || topPx < 0 || leftPx + w > roi.width || topPx + h > roi.height) return undefined;
	const total = w * h;
	let count = 0;
	let patchSum = 0;
	let templateSum = 0;
	for (let y = 0; y < h; y += 1) {
		const rasterRow = (topPx + y) * roi.width + leftPx;
		const templateRow = y * w;
		for (let x = 0; x < w; x += 1) {
			const index = rasterRow + x;
			if (!roi.trusted[index]) continue;
			count += 1;
			patchSum += roi.gray[index];
			templateSum += template.gray[templateRow + x];
		}
	}
	const trustedFraction = count / total;
	if (trustedFraction < MIN_TRUSTED_FRACTION) return undefined;
	const patchMean = patchSum / count;
	const templateMean = templateSum / count;
	let cross = 0;
	let patchEnergy = 0;
	let templateEnergy = 0;
	for (let y = 0; y < h; y += 1) {
		const rasterRow = (topPx + y) * roi.width + leftPx;
		const templateRow = y * w;
		for (let x = 0; x < w; x += 1) {
			const index = rasterRow + x;
			if (!roi.trusted[index]) continue;
			const patchValue = roi.gray[index] - patchMean;
			const templateValue = template.gray[templateRow + x] - templateMean;
			cross += patchValue * templateValue;
			patchEnergy += patchValue * patchValue;
			templateEnergy += templateValue * templateValue;
		}
	}
	if (patchEnergy <= 1e-6 || templateEnergy <= 1e-6) return undefined;
	return { score: cross / Math.sqrt(patchEnergy * templateEnergy), trustedFraction };
}

interface ScanBest {
	readonly score: number;
	readonly trustedFraction: number;
	readonly left: number;
	readonly top: number;
	readonly template: BasketFallbackTemplate;
}

function scan(
	roi: MaskedRoi,
	resizedByScale: readonly BasketFallbackTemplate[],
	centerXPx: number,
	centerYPx: number,
	radiusPx: number,
	stridePx: number,
	current?: ScanBest
): ScanBest | undefined {
	let best = current;
	for (const template of resizedByScale) {
		for (let dy = -radiusPx; dy <= radiusPx; dy += stridePx) {
			for (let dx = -radiusPx; dx <= radiusPx; dx += stridePx) {
				const left = Math.round(centerXPx + dx - template.widthPx / 2) - roi.x0;
				const top = Math.round(centerYPx + dy - template.heightPx * BASKET_BASE_Y_FRACTION) - roi.y0;
				const result = maskedNccAt(roi, template, left, top);
				if (!result || (best && result.score <= best.score)) continue;
				best = { ...result, left, top, template };
			}
		}
	}
	return best;
}

/**
 * Searches a narrow ROI around one unresolved hole's own badge for
 * surviving, occlusion-masked basket template evidence. Never scans the
 * full image. Coarse-to-fine like `sweepPadOrientation`'s rotation sweep,
 * to keep the manual (non-OpenCV) masked correlation affordable: OpenCV's
 * `matchTemplate` does not support a trusted-pixel mask for
 * `TM_CCOEFF_NORMED`, so this stays plain arithmetic over the ROI, matching
 * `teePadOrientation.ts`'s `maskedSweepSearch` approach.
 */
export function findOccludedBasketMatch(
	raster: BasketFallbackRaster,
	template: BasketFallbackTemplate,
	searchCenterXPx: number,
	searchCenterYPx: number,
	searchRadiusPx: number,
	templateScales: readonly number[],
	occlusionBoxes: readonly BasketBadgeBox[]
): OccludedBasketMatch | undefined {
	if (templateScales.length === 0) return undefined;
	const maxScale = Math.max(...templateScales);
	const halfTemplatePx = Math.max(template.widthPx, template.heightPx) * maxScale * 0.6;
	const roi = buildMaskedRoi(raster, searchCenterXPx, searchCenterYPx, searchRadiusPx + halfTemplatePx, occlusionBoxes);
	if (!roi) return undefined;

	const resizedByScale = templateScales
		.map((scale) => resizeGrayTemplate(template, scale))
		.filter((resized) => resized.widthPx < roi.width && resized.heightPx < roi.height);
	if (resizedByScale.length === 0) return undefined;

	const coarse = scan(roi, resizedByScale, searchCenterXPx, searchCenterYPx, searchRadiusPx, COARSE_STRIDE_PX);
	if (!coarse) return undefined;
	const refineCenterXPx = roi.x0 + coarse.left + coarse.template.widthPx / 2;
	const refineCenterYPx = roi.y0 + coarse.top + coarse.template.heightPx * BASKET_BASE_Y_FRACTION;
	const refined =
		scan(roi, resizedByScale, refineCenterXPx, refineCenterYPx, REFINE_RADIUS_PX, REFINE_STRIDE_PX, coarse) ?? coarse;

	if (refined.score < MIN_MASKED_SCORE) return undefined;
	return {
		xPx: roi.x0 + refined.left + refined.template.widthPx / 2,
		yPx: roi.y0 + refined.top + refined.template.heightPx * BASKET_BASE_Y_FRACTION,
		widthPx: refined.template.widthPx,
		heightPx: refined.template.heightPx,
		score: refined.score,
		trustedFraction: refined.trustedFraction
	};
}
