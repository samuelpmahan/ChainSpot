/**
 * The shared CV detector contract (docs/architecture-teardown.md §7).
 *
 * All production detectors (tee pads, baskets, hole numbers) and the grammar
 * stage that consumes their output independently converged on the same
 * candidate shape. This module names that shape once so future detectors
 * adopt it instead of reinventing it — intentionally just these two types,
 * no interface hierarchy, no pipeline framework, no plugin registry.
 */

import type { SourcePoint } from '../domain/project';

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
 * The one place a CV candidate becomes domain data: discards score/
 * confidence/dimensions so a future `{...candidate}` spread can't leak CV
 * fields onto `AnnotatedHole`. Structural on purpose — it accepts any
 * detector or grammar-stage assignment that carries an `{xPx, yPx}` location
 * (`BasketCandidate`, `TeeAssignment`, `BasketAssignment`, ...), not just
 * `Candidate` itself.
 */
export function acceptCandidate(candidate: Pick<Candidate, 'xPx' | 'yPx'>): SourcePoint {
	return { xPx: candidate.xPx, yPx: candidate.yPx };
}
