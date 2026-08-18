/**
 * Generic "detect in source space, merge into composite space" helper
 * (CHSPT-55/51, "Agent D — generic sprite pose").
 *
 * Detect on each unwarped source raster, then map observations through the
 * exact SourceTransform already owned by provenance. CHSPT-79 deliberately
 * reuses this seam for source-landmark handoff; no second transform
 * convention exists.
 */

import type { Candidate, CvRaster } from '../cv/types';
import type { CompositePoint, SourceTransform } from '../domain/provenance';
import { applySourceTransform } from '../domain/provenance';

export interface SourceSpaceInput<TRaster extends CvRaster = CvRaster> {
	readonly sourceId: string;
	readonly transform: SourceTransform;
	readonly raster: TRaster;
}

export interface CompositeObservation<TCandidate extends Candidate = Candidate> {
	readonly sourceId: string;
	readonly sourceCandidate: TCandidate;
	readonly compositePoint: CompositePoint;
}

/**
 * CHSPT-79's single-observation adapter. This is the same transform operation
 * `detectInSourceSpace` has always used, factored so a detector that already
 * ran earlier (Stitch Map semantic landmarks) can reuse the exact propagation
 * contract without pretending to run again.
 */
export function mapSourceCandidateToComposite<TCandidate extends Candidate>(
	sourceId: string,
	transform: SourceTransform,
	candidate: TCandidate
): CompositeObservation<TCandidate> {
	return {
		sourceId,
		sourceCandidate: candidate,
		compositePoint: applySourceTransform({ xPx: candidate.xPx, yPx: candidate.yPx }, transform)
	};
}

export function detectInSourceSpace<TRaster extends CvRaster, TCandidate extends Candidate>(
	sources: readonly SourceSpaceInput<TRaster>[],
	detect: (raster: TRaster, sourceId: string) => readonly TCandidate[]
): readonly CompositeObservation<TCandidate>[] {
	const observations: CompositeObservation<TCandidate>[] = [];
	for (const source of sources) {
		const candidates = detect(source.raster, source.sourceId);
		for (const candidate of candidates) {
			observations.push(mapSourceCandidateToComposite(source.sourceId, source.transform, candidate));
		}
	}
	return observations;
}
