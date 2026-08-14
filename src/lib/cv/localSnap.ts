/**
 * "Snap-to-detection": when a user places or repositions a tee/basket marker
 * in Annotate Round's Map mode, a short LOCAL object-finding pass runs around
 * the click and the placement snaps to whatever real feature it finds nearby.
 *
 * This module is the pure, environment-agnostic core -- modeled directly on
 * `teePadDetection.ts`/`basketTemplateDetection.ts`'s own boundary: it is
 * handed an already-decoded raster and the OpenCV instance that owns it, and
 * it does not load WASM, decode images, or touch editor state. That keeps it
 * trivially unit-testable with the same fake-`cv` pattern those modules'
 * tests already use (see `tests/unit/localSnap.test.ts`).
 *
 * The one thing this module owns that the full-course detectors don't need:
 * *cropping*. A full-course pass runs a detector over the whole analysis
 * raster because it doesn't know where the features are yet. A snap pass
 * already knows almost exactly where to look (the click), so it crops a
 * small window out of whatever raster it's given and runs the detector only
 * over that crop -- this is what keeps a snap pass "local" and fast rather
 * than repeating a full-course-sized search on every marker placement.
 *
 * Main-thread vs. worker (point 5 of the design): this module itself doesn't
 * decide -- it just needs a `cv` instance. The actual choice lives in the
 * caller. `$lib/components/AnnotationWorkspace.svelte` calls through the
 * *existing* `basketDetection.worker.ts` (a new `'local-snap'` request kind)
 * rather than loading a second OpenCV WASM instance on the main thread,
 * because:
 *
 *  - `loadCv()`'s own doc comments record a real measured swing of
 *    ~1s (browser-cached) to ~10-12s (cold/uncached) just to load and
 *    instantiate the WASM module once -- a cost this feature must never pay
 *    twice (once per thread) when the worker already owns a warm instance
 *    after "Detect course"/"Detect tees" has run, which is the normal Map
 *    mode workflow before a user is fine-placing individual markers.
 *  - Once warm, the detector work itself is cheap regardless of thread: a
 *    throwaway timing probe against this module's real detectors (not a fake
 *    `cv`) measured a 90x90 tee-pad crop at ~1.3ms/call and a realistic
 *    ~170x170 basket crop (matched-scale icon, not a degenerate flat
 *    template) at ~23ms/call, both on Node's real `@techstark/opencv-js`
 *    after a one-time ~400ms module load. A small crop is fast either way,
 *    exactly as the design anticipated.
 *  - What is *not* guaranteed fast is decoding the source image into an
 *    `ImageBitmap` to hand to the worker at all -- multi-megabyte course
 *    screenshots, and a cold worker on a session's very first placement
 *    (before any detection has warmed it) can plausibly exceed the ~100ms
 *    "feels instant" budget. So the wiring applies the raw click
 *    immediately (optimistic placement) and settles the marker to the
 *    snapped point only if/when the worker's reply arrives -- see that
 *    file's `requestLocalSnap`/`applyLocalSnapSettle` for the shipped path.
 */

import {
	asUiScalePx,
	deriveCanonicalUiScalePx
} from '../autoAnnotation/cvCalibration';
import type { BasketTemplateScale, UiScalePx } from '../autoAnnotation/cvCalibration';
import { detectCalibratedTeePadCandidates } from '../autoAnnotation/cvCalibratedDetectors';
import { detectBasketCandidatesAtTemplateScale } from '../autoAnnotation/cvCalibratedDetectors';
import type {
	CalibratedBasketCandidate,
	CalibratedTeePadDetectionOptions
} from '../autoAnnotation/cvCalibratedDetectors';
import type { TeePadCandidate, TeePadCv, TeePadRaster } from '../autoAnnotation/teePadDetection';
import type { BasketCv, BasketRaster, BasketTemplateRaster } from '../autoAnnotation/basketTemplateDetection';

export type LocalSnapKind = 'tee' | 'basket';

/** A source-image-pixel point; deliberately structural (matches `SourcePoint`/`Candidate`) so callers never need an import just to build one. */
export interface LocalSnapPoint {
	readonly xPx: number;
	readonly yPx: number;
}

/** The narrow OpenCV surface either branch needs -- both are always required so one `cv` module value works for either `kind` without a caller-side union dance, mirroring `basketDetection.worker.ts`'s own combined `RuntimeCv`. */
export type LocalSnapCv = TeePadCv & BasketCv;

/**
 * A raster covering (at least) the crop region this pass will need. Coordinate
 * convention matches every other detector raster in this codebase: `rgba`/
 * `gray` are the whole raster's pixels row-major from `(0,0)`, and
 * `sourceScale` is source-image pixels per raster pixel (1 at full
 * resolution). `clickPx` is always in source-image pixels, independent of
 * this raster's own resolution.
 */
export interface LocalSnapRaster {
	readonly widthPx: number;
	readonly heightPx: number;
	readonly sourceScale: number;
	/** Required when `kind === 'tee'`. */
	readonly rgba?: Uint8Array | Uint8ClampedArray;
	/** Required when `kind === 'basket'`. */
	readonly gray?: Uint8Array;
}

/**
 * Everything `localFeatureSnap` needs beyond the raster itself. `basket` is
 * optional at the type level because a `kind: 'tee'` call never touches it,
 * but it's required (checked at runtime, never thrown) for `kind: 'basket'`
 * -- exactly the "must be indistinguishable from no feature" contract: a
 * caller that hasn't calibrated a basket template yet gets `null`, not an
 * error.
 */
export interface LocalSnapCalibration {
	readonly uiScalePx: UiScalePx;
	readonly basket?: {
		readonly template: BasketTemplateRaster;
		readonly templateScale: BasketTemplateScale;
	};
}

/**
 * Upper bound on a tee pad's on-image footprint, in source-image pixels, at a
 * given `UiScalePx`. Mirrors `teePadDetection.ts`'s own widest accepted
 * candidate size: the `edge-loop` detector's major-axis ceiling is
 * `26 * scale`, where `scale` there is `options.uiScalePx / raster.sourceScale`
 * -- i.e. exactly `UiScalePx` once expressed in source-image pixels
 * (`sourceScale === 1`). Not imported directly since that constant is
 * `teePadDetection.ts`-local (deliberately: it's an internal detector-tuning
 * value, not part of that module's public contract), so it's restated here
 * with this comment as the enforced link between the two.
 */
export const TEE_PAD_MAX_FOOTPRINT_UI_SCALE_MULTIPLE = 26;

/**
 * Local snap's crop window is a square this many times the expected
 * feature's footprint on a side, centered on the click: big enough that a
 * feature whose true center is a bit off from where the user actually
 * clicked is still fully inside it, small enough to keep the pass a
 * genuinely *local*, fast search rather than a full-course-sized one. See
 * this module's top-of-file doc comment for the measured timings this is
 * tuned against.
 */
export const LOCAL_SNAP_CROP_FEATURE_MULTIPLE = 4;

/**
 * A snap is only allowed when the detected feature center is within half of
 * the expected feature footprint from the user's click. The crop stays wider
 * than this guard so nearby false positives can be rejected instead of being
 * accepted merely because they were visible to the detector.
 */
export const LOCAL_SNAP_RADIUS_FEATURE_MULTIPLE = 0.5;

/**
 * A candidate must score at least this well to be trusted. Matches
 * `basketTemplateDetection.ts`'s own `DEFAULT_MIN_SCORE` floor used for
 * full-course basket detection; applied uniformly to tee-pad candidates too
 * since a local crop is a much smaller, cleaner search than a full-course
 * pass and shouldn't need a laxer bar to accept a real feature.
 */
export const LOCAL_SNAP_MIN_SCORE = 0.5;

/** Below this many pixels on a side, a crop can't meaningfully contain a feature; treated the same as a crop that missed the raster entirely. */
const MIN_CROP_SIDE_PX = 4;

interface CropBounds {
	readonly x0: number;
	readonly y0: number;
	readonly widthPx: number;
	readonly heightPx: number;
}

/**
 * Re-derives the crop constants' interaction with a real course capture's
 * calibration in one place, so `localFeatureSnap`'s own body reads as the
 * three real steps (crop, detect, judge) rather than this arithmetic.
 */
function featureFootprintSourcePx(
	kind: LocalSnapKind,
	calibration: LocalSnapCalibration
): number | null {
	if (kind === 'tee') {
		return TEE_PAD_MAX_FOOTPRINT_UI_SCALE_MULTIPLE * calibration.uiScalePx;
	}
	const basket = calibration.basket;
	if (!basket) return null;
	return Math.max(basket.template.widthPx, basket.template.heightPx) * basket.templateScale;
}

/** Intersects the requested crop window with the raster's own bounds; `null` when nothing usable is left (click off-raster, degenerate raster, etc.) -- this is the "empty crop" case `localFeatureSnap` treats as no feature found. */
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

function teeCropCandidates(
	cv: LocalSnapCv,
	raster: LocalSnapRaster,
	bounds: CropBounds,
	uiScalePx: UiScalePx
): readonly TeePadCandidate[] | null {
	if (!raster.rgba) return null;
	const cropped: TeePadRaster = {
		rgba: cropRgba(raster.rgba, raster.widthPx, bounds),
		widthPx: bounds.widthPx,
		heightPx: bounds.heightPx,
		sourceScale: raster.sourceScale
	};
	const options: CalibratedTeePadDetectionOptions = { uiScalePx };
	return detectCalibratedTeePadCandidates(cv, cropped, options);
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

/**
 * Runs a short local object-finding pass around `clickPx` and returns the
 * snapped point, or `null` when nothing trustworthy was found -- a `null`
 * result is indistinguishable from "no feature exists here" and callers must
 * treat it exactly like that (place the raw click, no error, no retry).
 *
 * Mechanics: crop a window `LOCAL_SNAP_CROP_FEATURE_MULTIPLE`x the expected
 * feature footprint (derived from `calibration`) around `clickPx`, run only
 * the one relevant existing detector against that crop, and offset its best
 * candidate back into `raster`'s own source-image coordinate space. The
 * result is accepted only when that candidate both clears
 * `LOCAL_SNAP_MIN_SCORE` and lies within
 * `LOCAL_SNAP_RADIUS_FEATURE_MULTIPLE` expected feature footprints of
 * `clickPx` -- a real nearby feature, not just the least-bad thing the
 * detector could find inside an arbitrary window.
 */
export function localFeatureSnap(
	kind: LocalSnapKind,
	cv: LocalSnapCv,
	raster: LocalSnapRaster,
	clickPx: LocalSnapPoint,
	calibration: LocalSnapCalibration
): LocalSnapPoint | null {
	if (!Number.isFinite(clickPx.xPx) || !Number.isFinite(clickPx.yPx)) return null;
	if (!(calibration.uiScalePx > 0)) return null;

	const footprintPx = featureFootprintSourcePx(kind, calibration);
	if (footprintPx === null || !(footprintPx > 0)) return null;

	const cropSideSourcePx = footprintPx * LOCAL_SNAP_CROP_FEATURE_MULTIPLE;
	const snapRadiusPx = footprintPx * LOCAL_SNAP_RADIUS_FEATURE_MULTIPLE;
	const bounds = computeCropBounds(raster, clickPx, cropSideSourcePx);
	if (!bounds) return null;

	const originXPx = bounds.x0 * raster.sourceScale;
	const originYPx = bounds.y0 * raster.sourceScale;

	const candidates =
		kind === 'tee'
			? teeCropCandidates(cv, raster, bounds, calibration.uiScalePx)
			: basketCropCandidates(cv, raster, bounds, calibration);
	if (!candidates || candidates.length === 0) return null;

	let best: { xPx: number; yPx: number; score: number } | null = null;
	for (const candidate of candidates) {
		const score = candidate.score ?? -Infinity;
		if (!best || score > best.score) {
			best = { xPx: originXPx + candidate.xPx, yPx: originYPx + candidate.yPx, score };
		}
	}
	if (!best || best.score < LOCAL_SNAP_MIN_SCORE) return null;

	const distancePx = Math.hypot(best.xPx - clickPx.xPx, best.yPx - clickPx.yPx);
	if (distancePx > snapRadiusPx) return null;

	return { xPx: best.xPx, yPx: best.yPx };
}

// Re-exported so callers deriving a `LocalSnapCalibration` from a number-badge
// anchor (the same one `handleDetectTees`/`detectCourse` already use) don't
// need a second import path to reach the one canonical conversion.
export { asUiScalePx, deriveCanonicalUiScalePx };
export type { UiScalePx, BasketTemplateScale };
