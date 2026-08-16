/**
 * Basket-specific instantiation of the generic `detectInSourceSpace` merge
 * helper (CHSPT-55/51). Baskets are the validation case for the generic
 * pose-query/source-space API, not a special API of their own: this file
 * exists only to wire `basketTemplateDetection.ts`'s existing upright-only
 * matcher (unmodified) through `sourceSpaceDetection.ts`'s detector-agnostic
 * merge logic, kept separate so `sourceSpaceDetection.ts` itself never
 * mentions "basket."
 */

import type { BasketCandidate, BasketCv, BasketDetectionOptions, BasketRaster, BasketTemplateRaster } from './basketTemplateDetection';
import { detectBasketTemplateCandidates } from './basketTemplateDetection';
import type { CompositeObservation, SourceSpaceInput } from './sourceSpaceDetection';
import { detectInSourceSpace } from './sourceSpaceDetection';

/**
 * Detects baskets on each source's own (unwarped, canonically-upright)
 * raster via the existing `detectBasketTemplateCandidates` -- untouched --
 * and returns every candidate's composite-space location via that source's
 * own `SourceTransform`. `options` is shared across every source; a caller
 * whose sources have different calibration (e.g. different `uiScalePx`) must
 * call `detectInSourceSpace` directly with a per-source detector closure
 * instead.
 */
export function detectBasketsInSourceSpace(
	cv: BasketCv,
	sources: readonly SourceSpaceInput<BasketRaster>[],
	template: BasketTemplateRaster,
	options: BasketDetectionOptions
): readonly CompositeObservation<BasketCandidate>[] {
	return detectInSourceSpace(sources, (raster) => detectBasketTemplateCandidates(cv, raster, template, options));
}
