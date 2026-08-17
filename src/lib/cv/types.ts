/**
 * The shared CV detector contract (docs/architecture-teardown.md §7).
 *
 * All production detectors (tee pads, baskets, hole numbers) and the grammar
 * stage that consumes their output independently converged on the same
 * candidate shape. This module names that shape once so future detectors
 * adopt it instead of reinventing it.
 */

import type { SourcePoint } from '../domain/project';
import { recordSurfacedCandidate } from './funnelRuntime';
import type { LandmarkKind } from './landmarkTrace';

/** A detected point of interest, in source-image pixels. */
export interface Candidate {
	readonly xPx: number;
	readonly yPx: number;
	readonly widthPx?: number;
	readonly heightPx?: number;
	/** Detector quality/confidence signal, when the detector has one. */
	readonly score?: number;
}

/**
 * Optional runtime-only evidence carried by staged recommendation objects to
 * the one CV->domain acceptance boundary. These fields are observed here and
 * deliberately discarded from the returned SourcePoint.
 */
interface AcceptCandidateEvidence {
	readonly landmarkKind?: LandmarkKind;
	readonly candidateIndex?: number;
	readonly widthPx?: number;
	readonly heightPx?: number;
}

/**
 * A decoded raster handed to a detector, modeled on `stitch/analysis.ts`'s
 * `AnalysisRaster`. Detectors vary in which channel(s) they need and whether
 * the raster has already been downscaled from the source image, so every
 * raster declares its source-space conversion explicitly while a given
 * detector's own raster type narrows the channel fields it requires.
 */
export interface CvRaster {
	readonly widthPx: number;
	readonly heightPx: number;
	readonly gray?: Uint8Array;
	readonly rgba?: Uint8Array | Uint8ClampedArray;
	/** Source pixels per raster pixel: 1 at full resolution, >1 after a downsample. */
	readonly sourceScale: number;
}

/**
 * The one place a CV candidate becomes domain data: discards score,
 * confidence, dimensions, and all diagnostic metadata so CV provenance never
 * leaks onto `AnnotatedHole`.
 *
 * Staged Pancake recommendations may carry `landmarkKind` + footprint as
 * runtime-only evidence. Recording that here gives an exact "surfaced"
 * event at the same boundary that creates the authoritative SourcePoint,
 * without coupling the annotation component to CV diagnostics.
 */
export function acceptCandidate(candidate: Pick<Candidate, 'xPx' | 'yPx'>): SourcePoint {
	const evidence = candidate as Pick<Candidate, 'xPx' | 'yPx'> & AcceptCandidateEvidence;
	if (evidence.landmarkKind === 'tee' || evidence.landmarkKind === 'basket') {
		recordSurfacedCandidate({
			kind: evidence.landmarkKind,
			xPx: candidate.xPx,
			yPx: candidate.yPx,
			...(typeof evidence.candidateIndex === 'number' ? { candidateIndex: evidence.candidateIndex } : {}),
			...(typeof evidence.widthPx === 'number' ? { widthPx: evidence.widthPx } : {}),
			...(typeof evidence.heightPx === 'number' ? { heightPx: evidence.heightPx } : {})
		});
	}
	return { xPx: candidate.xPx, yPx: candidate.yPx };
}
