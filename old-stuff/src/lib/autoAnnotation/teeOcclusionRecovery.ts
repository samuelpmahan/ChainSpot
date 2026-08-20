/**
 * Occlusion-tolerant tee-pad recovery fallback.
 *
 * Mirrors `basketOcclusionRecovery.ts`'s technique for the analogous basket
 * case (see `docs/deferred-detection-experiments.md` for why the earlier
 * rail-pair-based occlusion masking attempt wasn't enough on its own): a
 * masked, coarse-to-fine zero-mean NCC search for a synthesized tee-pad
 * rectangle template, scored only over pixels not covered by a known
 * occluder (a number badge, a putting-circle ring, or a basket icon).
 *
 * This reuses the exact rim/interior/background rectangle synthesis already
 * proven in `teeBootstrapPolicy.ts`'s weak-tee-candidate search (`PAD_ASPECT`,
 * `PAD_RIM_FRACTION`, the same three-band raster), but that search has no
 * masking: an occluded pad's corrupted pixels pull its score down along with
 * everyone else's rather than being excluded. This module is a narrow,
 * ROI-scoped, masking-aware sibling to it -- not a replacement. The primary
 * detectors and the existing weak-candidate sweep are untouched.
 */

export interface TeeOcclusionBadgeBox {
	readonly xPx: number;
	readonly yPx: number;
	readonly widthPx: number;
	readonly heightPx: number;
}

/** Same shape as `TeePadDetectionOptions['ignoreCirclesPx']` -- a full disc when `innerRadiusPx` is omitted, an annulus otherwise. */
export interface TeeOcclusionCircle {
	readonly xPx: number;
	readonly yPx: number;
	readonly radiusPx: number;
	readonly innerRadiusPx?: number;
}

export interface TeeOcclusionRaster {
	readonly rgba: Uint8Array | Uint8ClampedArray;
	readonly widthPx: number;
	readonly heightPx: number;
}

export interface OccludedTeePadMatch {
	readonly xPx: number;
	readonly yPx: number;
	/** Normalized to [0, 180), matching `TeePadCandidate.orientationDeg`'s convention. */
	readonly orientationDeg: number;
	readonly majorPx: number;
	readonly minorPx: number;
	readonly score: number;
	readonly trustedFraction: number;
}

const PAD_ASPECT = 1.45;
const PAD_RIM_FRACTION = 0.11;
const TEMPLATE_MARGIN_PX = 2;
/** A rectangular badge box occludes its full extent, not just glyph edges, so the mask needs only a small anti-aliasing margin. */
const OCCLUSION_MASK_MARGIN_PX = 2;
/**
 * A masked match must still cover a meaningful share of the template; below
 * this, "evidence" is really just noise. Set higher than
 * `basketOcclusionRecovery.ts`'s equivalent (0.2): that search never sweeps
 * orientation or a size range, so it has far fewer degrees of freedom and a
 * low trusted-pixel count is still a meaningful signal there. This search
 * sweeps size x angle x position simultaneously -- checked empirically
 * (IMG_5641 hole 3): a 0.2 floor let a 16.5px template correlate strongly
 * (score 0.89) with unrelated structure 300px from the true tee, using only
 * 30% of its pixels. Too few real data points make NCC scores unreliable.
 */
export const MIN_TRUSTED_FRACTION = 0.55;
/** Same rationale as `basketOcclusionRecovery.ts`'s constant of the same name: a different statistic than the primary detector's floor, scoped to a small masked ROI. */
export const MIN_MASKED_SCORE = 0.6;
const COARSE_ANGLE_STEP_DEG = 15;
const FINE_ANGLE_STEP_DEG = 3;
const FINE_ANGLE_SPAN_DEG = 15;
const COARSE_STRIDE_PX = 6;
const REFINE_STRIDE_PX = 2;
const REFINE_RADIUS_MULTIPLE = 2;

function normalizeAxisDeg(angleDeg: number): number {
	const normalized = angleDeg % 180;
	return normalized < 0 ? normalized + 180 : normalized;
}

interface MaskedTemplate {
	readonly angleDeg: number;
	readonly majorPx: number;
	readonly minorPx: number;
	readonly width: number;
	readonly height: number;
	readonly halfWidth: number;
	readonly halfHeight: number;
	/** Raw (not zero-mean) pixel values -- masked NCC recomputes the mean over only trusted pixels per position, so it can't be pre-centered. */
	readonly values: Float32Array;
}

/** Same rectangle synthesis as `teeBootstrapPolicy.ts`'s `synthesizeTemplate`, reimplemented self-contained per this file's established sibling-module convention (see `basketOcclusionRecovery.ts`). */
function synthesizeMaskedTemplate(majorPx: number, angleDeg: number): MaskedTemplate {
	const minorPx = majorPx / PAD_ASPECT;
	const rimPx = Math.max(1, majorPx * PAD_RIM_FRACTION);
	const radians = (angleDeg * Math.PI) / 180;
	const cosine = Math.cos(radians);
	const sine = Math.sin(radians);
	const halfWidth = Math.ceil(Math.abs((majorPx / 2) * cosine) + Math.abs((minorPx / 2) * sine)) + TEMPLATE_MARGIN_PX;
	const halfHeight = Math.ceil(Math.abs((majorPx / 2) * sine) + Math.abs((minorPx / 2) * cosine)) + TEMPLATE_MARGIN_PX;
	const width = halfWidth * 2 + 1;
	const height = halfHeight * 2 + 1;
	const values = new Float32Array(width * height);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const dx = x - halfWidth;
			const dy = y - halfHeight;
			const localX = dx * cosine + dy * sine;
			const localY = -dx * sine + dy * cosine;
			const insideOuter = Math.abs(localX) <= majorPx / 2 && Math.abs(localY) <= minorPx / 2;
			const insideInner = Math.abs(localX) <= majorPx / 2 - rimPx && Math.abs(localY) <= minorPx / 2 - rimPx;
			values[y * width + x] = insideInner ? 158 : insideOuter ? 235 : 120;
		}
	}
	return { angleDeg: normalizeAxisDeg(angleDeg), majorPx, minorPx, width, height, halfWidth, halfHeight, values };
}

interface MaskedRoi {
	readonly x0: number;
	readonly y0: number;
	readonly width: number;
	readonly height: number;
	readonly gray: Uint8Array;
	readonly trusted: Uint8Array;
}

function maskCircle(trusted: Uint8Array, width: number, height: number, x0: number, y0: number, circle: TeeOcclusionCircle): void {
	const centerX = circle.xPx - x0;
	const centerY = circle.yPx - y0;
	const radius = circle.radiusPx;
	const innerRadius = Math.max(0, circle.innerRadiusPx ?? 0);
	if (!Number.isFinite(centerX) || !Number.isFinite(centerY) || !Number.isFinite(radius) || radius <= 0) return;
	const radiusSquared = radius * radius;
	const innerRadiusSquared = innerRadius * innerRadius;
	const firstX = Math.max(0, Math.floor(centerX - radius));
	const lastX = Math.min(width - 1, Math.ceil(centerX + radius));
	const firstY = Math.max(0, Math.floor(centerY - radius));
	const lastY = Math.min(height - 1, Math.ceil(centerY + radius));
	for (let y = firstY; y <= lastY; y += 1) {
		for (let x = firstX; x <= lastX; x += 1) {
			const dx = x - centerX;
			const dy = y - centerY;
			const distanceSquared = dx * dx + dy * dy;
			if (distanceSquared <= radiusSquared && distanceSquared >= innerRadiusSquared) {
				trusted[y * width + x] = 0;
			}
		}
	}
}

function buildMaskedRoi(
	raster: TeeOcclusionRaster,
	centerXPx: number,
	centerYPx: number,
	halfSizePx: number,
	badgeBoxes: readonly TeeOcclusionBadgeBox[],
	circles: readonly TeeOcclusionCircle[]
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
		for (let x = 0; x < width; x += 1) {
			const sourceOffset = ((y0 + y) * raster.widthPx + x0 + x) * 4;
			gray[y * width + x] = (
				raster.rgba[sourceOffset] * 0.299 +
				raster.rgba[sourceOffset + 1] * 0.587 +
				raster.rgba[sourceOffset + 2] * 0.114 +
				0.5
			) | 0;
		}
	}

	const trusted = new Uint8Array(width * height);
	trusted.fill(1);
	for (const box of badgeBoxes) {
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
	for (const circle of circles) maskCircle(trusted, width, height, x0, y0, circle);

	return { x0, y0, width, height, gray, trusted };
}

function maskedNccAt(
	roi: MaskedRoi,
	template: MaskedTemplate,
	leftPx: number,
	topPx: number
): { score: number; trustedFraction: number } | undefined {
	const w = template.width;
	const h = template.height;
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
			templateSum += template.values[templateRow + x];
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
			const templateValue = template.values[templateRow + x] - templateMean;
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
	readonly template: MaskedTemplate;
}

function scan(
	roi: MaskedRoi,
	templates: readonly MaskedTemplate[],
	centerXPx: number,
	centerYPx: number,
	radiusPx: number,
	stridePx: number,
	current?: ScanBest
): ScanBest | undefined {
	let best = current;
	for (const template of templates) {
		for (let dy = -radiusPx; dy <= radiusPx; dy += stridePx) {
			for (let dx = -radiusPx; dx <= radiusPx; dx += stridePx) {
				const left = Math.round(centerXPx + dx - template.halfWidth) - roi.x0;
				const top = Math.round(centerYPx + dy - template.halfHeight) - roi.y0;
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
 * surviving, occlusion-masked tee-pad template evidence. Never scans the
 * full image. Coarse-to-fine, like `findOccludedBasketMatch`: a coarse pass
 * over every candidate size and a 15°-stepped angle sweep (pad orientation
 * is not known in advance here, unlike the basket case), then a fine
 * position+angle refinement around the coarse winner.
 */
export function findOccludedTeePadMatch(
	raster: TeeOcclusionRaster,
	searchCenterXPx: number,
	searchCenterYPx: number,
	searchRadiusPx: number,
	majorSizesPx: readonly number[],
	badgeBoxes: readonly TeeOcclusionBadgeBox[],
	circles: readonly TeeOcclusionCircle[]
): OccludedTeePadMatch | undefined {
	if (majorSizesPx.length === 0) return undefined;
	const maxMajorPx = Math.max(...majorSizesPx);
	const roi = buildMaskedRoi(raster, searchCenterXPx, searchCenterYPx, searchRadiusPx + maxMajorPx, badgeBoxes, circles);
	if (!roi) return undefined;

	const coarseTemplates: MaskedTemplate[] = [];
	for (const majorPx of majorSizesPx) {
		for (let angleDeg = 0; angleDeg < 180; angleDeg += COARSE_ANGLE_STEP_DEG) {
			coarseTemplates.push(synthesizeMaskedTemplate(majorPx, angleDeg));
		}
	}
	const coarse = scan(roi, coarseTemplates, searchCenterXPx, searchCenterYPx, searchRadiusPx, COARSE_STRIDE_PX);
	if (!coarse) return undefined;

	const fineTemplates: MaskedTemplate[] = [];
	for (
		let angleDeg = coarse.template.angleDeg - FINE_ANGLE_SPAN_DEG;
		angleDeg <= coarse.template.angleDeg + FINE_ANGLE_SPAN_DEG;
		angleDeg += FINE_ANGLE_STEP_DEG
	) {
		fineTemplates.push(synthesizeMaskedTemplate(coarse.template.majorPx, angleDeg));
	}
	const refineCenterXPx = roi.x0 + coarse.left + coarse.template.halfWidth;
	const refineCenterYPx = roi.y0 + coarse.top + coarse.template.halfHeight;
	const refined =
		scan(
			roi,
			fineTemplates,
			refineCenterXPx,
			refineCenterYPx,
			COARSE_STRIDE_PX * REFINE_RADIUS_MULTIPLE,
			REFINE_STRIDE_PX,
			coarse
		) ?? coarse;

	if (refined.score < MIN_MASKED_SCORE) return undefined;
	return {
		xPx: roi.x0 + refined.left + refined.template.halfWidth,
		yPx: roi.y0 + refined.top + refined.template.halfHeight,
		orientationDeg: refined.template.angleDeg,
		majorPx: refined.template.majorPx,
		minorPx: refined.template.minorPx,
		score: refined.score,
		trustedFraction: refined.trustedFraction
	};
}
