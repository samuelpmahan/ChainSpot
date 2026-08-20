/**
 * Basket-specific single-pose matcher for `constrainedPoseDetection.ts`'s
 * generic sweep-restricted-to-a-finite-list harness (CHSPT-55/51). Baskets
 * are the validation case for the generic constrained-composite-space
 * fallback path, not a special API of their own -- this file supplies the
 * `detectAtPose` dependency `detectAtConstrainedPoses` needs, kept separate
 * so `constrainedPoseDetection.ts` itself never mentions "basket."
 *
 * `basketTemplateDetection.ts`'s own `BasketCv` surface has no rotation
 * primitive (no `warpAffine`), and today's `detectBasketTemplateCandidates`
 * assumes an upright template throughout -- reasonably, since it is the
 * "captures always render upright" detector this whole slice exists to stop
 * assuming. Rather than widen that locked, tested surface, this module
 * rotates the (small) canonical basket TEMPLATE itself in plain TypeScript
 * before handing it to the same `cv.matchTemplate`/`cv.minMaxLoc` primitives
 * `findBasketAnchorScale` already uses -- one scale+rotation pair per call,
 * matching the "search only the caller-supplied poses" contract.
 */

import type { BasketCandidate, BasketCv, BasketRaster, BasketTemplateRaster } from './basketTemplateDetection';
import type { ConstrainedPose } from './constrainedPoseDetection';

/** Matches `basketTemplateDetection.ts`'s own semantic endpoint: bottom-center stem base. */
const BASKET_BASE_Y_FRACTION = 0.96;
const DEFAULT_MIN_SCORE = 0.5;

interface RotatedTemplateRaster {
	readonly gray: Uint8Array;
	readonly widthPx: number;
	readonly heightPx: number;
}

/**
 * Resamples `template` rotated by `pose.rotationDeg` (degrees, same sign
 * convention as `sourcePose.ts`'s `rotationDegreesForTransform`: the angle a
 * source's local x-axis appears at once mapped into the space being
 * searched) and scaled by `pose.scale`, via nearest-neighbor inverse
 * mapping. Nearest-neighbor (not bilinear) matches this module's scope --
 * this feeds a normalized-cross-correlation match score, not a rendered
 * pixel a human ever sees, so sub-pixel interpolation quality is not
 * load-bearing here the way it is for `domain/provenance.ts`'s reconstruction
 * renderer.
 */
function rotateAndScaleTemplate(template: BasketTemplateRaster, pose: ConstrainedPose): RotatedTemplateRaster {
	if (!(pose.scale > 0)) {
		throw new Error('detectBasketCandidatesAtPose requires a positive pose.scale.');
	}
	const radians = (pose.rotationDeg * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	const srcWidthPx = template.widthPx;
	const srcHeightPx = template.heightPx;
	const outWidthPx = Math.max(1, Math.round((Math.abs(srcWidthPx * cos) + Math.abs(srcHeightPx * sin)) * pose.scale));
	const outHeightPx = Math.max(1, Math.round((Math.abs(srcWidthPx * sin) + Math.abs(srcHeightPx * cos)) * pose.scale));
	const out = new Uint8Array(outWidthPx * outHeightPx);
	const centerXPx = srcWidthPx / 2;
	const centerYPx = srcHeightPx / 2;
	const outCenterXPx = outWidthPx / 2;
	const outCenterYPx = outHeightPx / 2;
	for (let y = 0; y < outHeightPx; y += 1) {
		for (let x = 0; x < outWidthPx; x += 1) {
			const dx = (x - outCenterXPx) / pose.scale;
			const dy = (y - outCenterYPx) / pose.scale;
			// Inverse rotation: which canonical-template pixel maps forward to
			// this rotated-raster output pixel.
			const sourceXPx = dx * cos + dy * sin + centerXPx;
			const sourceYPx = -dx * sin + dy * cos + centerYPx;
			const sourceX = Math.round(sourceXPx);
			const sourceY = Math.round(sourceYPx);
			out[y * outWidthPx + x] =
				sourceX >= 0 && sourceY >= 0 && sourceX < srcWidthPx && sourceY < srcHeightPx
					? template.gray[sourceY * srcWidthPx + sourceX]
					: 0;
		}
	}
	return { gray: out, widthPx: outWidthPx, heightPx: outHeightPx };
}

function matFromBytes(cv: BasketCv, bytes: Uint8Array, width: number, height: number) {
	const mat = new cv.Mat(height, width, cv.CV_8UC1);
	mat.data.set(bytes);
	return mat;
}

export interface BasketConstrainedPoseOptions {
	readonly minScore?: number;
	readonly mapBoundsPx?: Readonly<{ topPx: number; bottomPx: number }>;
}

/**
 * Matches the canonical basket template against `raster` at exactly ONE pose
 * (rotation + scale) -- the single-match primitive `detectAtConstrainedPoses`
 * calls once per caller-supplied pose. Returns at most one candidate (the
 * pose's own best match, via `cv.minMaxLoc`), unlike
 * `detectBasketTemplateCandidates`'s full local-maxima harvest across a
 * blind scale-only sweep -- appropriate here because the caller already
 * knows there are only a handful of plausible poses to check, typically one
 * per contributing source at a given region.
 */
export function detectBasketCandidatesAtPose(
	cv: BasketCv,
	raster: BasketRaster,
	template: BasketTemplateRaster,
	pose: ConstrainedPose,
	options: BasketConstrainedPoseOptions = {}
): readonly BasketCandidate[] {
	const rotated = rotateAndScaleTemplate(template, pose);
	if (rotated.widthPx >= raster.widthPx || rotated.heightPx >= raster.heightPx) return [];

	const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
	const image = matFromBytes(cv, raster.gray, raster.widthPx, raster.heightPx);
	const templateMat = matFromBytes(cv, rotated.gray, rotated.widthPx, rotated.heightPx);
	const result = new cv.Mat();
	try {
		cv.matchTemplate(image, templateMat, result, cv.TM_CCOEFF_NORMED);
		const { maxVal, maxLoc } = cv.minMaxLoc(result);
		if (maxVal < minScore) return [];
		const centerXPx = (maxLoc.x + rotated.widthPx / 2) * raster.sourceScale;
		const centerYPx = (maxLoc.y + rotated.heightPx * BASKET_BASE_Y_FRACTION) * raster.sourceScale;
		if (options.mapBoundsPx && (centerYPx < options.mapBoundsPx.topPx || centerYPx > options.mapBoundsPx.bottomPx)) {
			return [];
		}
		return [
			{
				xPx: centerXPx,
				yPx: centerYPx,
				score: maxVal,
				widthPx: rotated.widthPx * raster.sourceScale,
				heightPx: rotated.heightPx * raster.sourceScale,
				scale: pose.scale * raster.sourceScale
			}
		];
	} finally {
		image.delete();
		templateMat.delete();
		result.delete();
	}
}
