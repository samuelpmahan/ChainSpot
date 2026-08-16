/**
 * Generic "detect in source space, merge into composite space" helper
 * (CHSPT-55/51, "Agent D — generic sprite pose").
 *
 * The preferred strategy from the ticket: rather than searching an arbitrary
 * angle/scale space on the flattened composite raster, detect on each
 * UNWARPED source raster individually -- where a repeated sprite (basket,
 * number badge, tee-related UI, ...) still has its canonical, unrotated
 * appearance, so an existing upright-only detector applies almost as-is --
 * then map each source-space observation into composite space via that
 * source's own `SourceTransform`.
 *
 * This module is deliberately detector-agnostic: `detectInSourceSpace` takes
 * the detector function as a parameter/dependency rather than hardcoding any
 * one sprite kind, so the exact same merge logic is usable for baskets,
 * number badges, tee pads, or a sprite type that doesn't exist yet -- see
 * `basketSourceSpaceDetection.ts` for a thin basket-specific wrapper, kept
 * separate so this module itself never mentions "basket."
 */

import type { Candidate, CvRaster } from '../cv/types';
import type { CompositePoint, SourceTransform } from '../domain/provenance';
import { applySourceTransform } from '../domain/provenance';

/** One source capture's raster, paired with the transform that places it into composite space. */
export interface SourceSpaceInput<TRaster extends CvRaster = CvRaster> {
	readonly sourceId: string;
	readonly transform: SourceTransform;
	readonly raster: TRaster;
}

/** A source-space candidate, restated with its composite-space location. */
export interface CompositeObservation<TCandidate extends Candidate = Candidate> {
	readonly sourceId: string;
	/** The original detector output, in that source's own raster pixels -- untouched, so callers keep access to `score`/`widthPx`/`heightPx`/any detector-specific fields. */
	readonly sourceCandidate: TCandidate;
	/** `sourceCandidate`'s `{xPx, yPx}` mapped into composite space via the source's own transform. */
	readonly compositePoint: CompositePoint;
}

/**
 * Runs `detect` against each source's own raster independently, then maps
 * every resulting candidate's `{xPx, yPx}` into composite space via that
 * source's `transform`. Does not merge/deduplicate observations that land at
 * the same composite location from different sources (e.g. a genuine overlap
 * region) -- that policy question belongs to the caller, which knows what
 * "the same sprite" means for its own candidate shape (score comparison,
 * NMS radius, ...); this function only ever performs the coordinate mapping.
 *
 * Note on extents: `TCandidate.widthPx/heightPx` (when present) are NOT
 * transformed here -- they are source-raster extents, and a rotated or
 * anisotropically-scaled transform does not, in general, map an axis-aligned
 * source-space box to an axis-aligned composite-space box. A caller that
 * needs a composite-space footprint (not just a point) must derive it itself
 * by transforming the box's corners individually.
 */
export function detectInSourceSpace<TRaster extends CvRaster, TCandidate extends Candidate>(
	sources: readonly SourceSpaceInput<TRaster>[],
	detect: (raster: TRaster, sourceId: string) => readonly TCandidate[]
): readonly CompositeObservation<TCandidate>[] {
	const observations: CompositeObservation<TCandidate>[] = [];
	for (const source of sources) {
		const candidates = detect(source.raster, source.sourceId);
		for (const candidate of candidates) {
			observations.push({
				sourceId: source.sourceId,
				sourceCandidate: candidate,
				compositePoint: applySourceTransform({ xPx: candidate.xPx, yPx: candidate.yPx }, source.transform)
			});
		}
	}
	return observations;
}
