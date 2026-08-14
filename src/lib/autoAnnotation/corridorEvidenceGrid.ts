/**
 * Shared corridor-EVIDENCE contract: a per-hole scalar "how likely is this
 * cell part of the fairway ribbon corridor" field, in `[0,1]`, plus enough
 * geometry to map its cells back to SOURCE-image pixels. Mirrors
 * `CorridorBendRaster` (`corridorBendDetection.ts`) field-for-field —
 * `widthPx`/`heightPx`/`originXPx`/`originYPx`/`scale` all carry the exact
 * same semantics — with a single evidence scalar per cell in place of RGBA
 * bytes.
 *
 * This module is deliberately tiny and import-free: it exists to be a
 * stable contract BETWEEN evidence producers and evidence consumers, so
 * neither has to know how the other is built.
 *
 * - `corridorBendDetectionCapsule.ts`'s `buildClassicCorridorEvidence` is one
 *   producer on this branch — this branch's own port of
 *   `hole_path_capsule_fit.py`'s LAB-lightness-minus-box-mean evidence map,
 *   used only to validate `fitCapsuleBends` against the original Python
 *   probe (see that module's doc comment: it is arm-C validation scaffolding,
 *   not a production evidence source).
 * - A separate, parallel piece of work is expected to produce grids in this
 *   exact shape from this branch's newer ribbon-mass/occluder-bridge/ring-arc
 *   research. `fitCapsuleBends` (`corridorBendDetectionCapsule.ts`) must stay
 *   able to consume EITHER without caring which one built it — it only ever
 *   reads `.evidence`, and this module must never import a specific
 *   evidence-builder so that invariant can't accidentally erode.
 *
 * No capsule-fitting or evidence-construction logic belongs here — see
 * `corridorBendDetectionCapsule.ts` for both.
 */
import type { SourcePoint } from '../domain/annotatedRound';

export interface CorridorEvidenceGrid {
	readonly widthPx: number;
	readonly heightPx: number;
	/** Top-left corner of this grid, in SOURCE-image pixels. */
	readonly originXPx: number;
	readonly originYPx: number;
	/** Source pixels per grid px (matches `CorridorBendRaster.scale`'s convention exactly: 1 = no downscale). */
	readonly scale: number;
	/** Row-major, length = widthPx*heightPx, each value in [0,1]: higher = more likely corridor ribbon. */
	readonly evidence: Float32Array;
}

/**
 * Maps a SOURCE-image point into `grid`'s own local pixel space. May land
 * outside `[0,widthPx) x [0,heightPx)` — callers that need an in-bounds
 * guarantee check separately with `isInsideEvidenceGrid`, mirroring
 * `corridorBendDetection.ts`'s own private `toLocal`/`inBounds` split.
 */
export function toEvidenceGridLocal(grid: CorridorEvidenceGrid, point: SourcePoint): SourcePoint {
	return { xPx: (point.xPx - grid.originXPx) / grid.scale, yPx: (point.yPx - grid.originYPx) / grid.scale };
}

/** Maps a point already in `grid`'s local pixel space back to SOURCE-image pixels — the inverse of `toEvidenceGridLocal`. */
export function toEvidenceGridSource(grid: CorridorEvidenceGrid, local: SourcePoint): SourcePoint {
	return { xPx: local.xPx * grid.scale + grid.originXPx, yPx: local.yPx * grid.scale + grid.originYPx };
}

/** True when `local` (already in `grid`'s own local pixel space — see `toEvidenceGridLocal`) falls inside `[0,widthPx) x [0,heightPx)`. */
export function isInsideEvidenceGrid(grid: CorridorEvidenceGrid, local: SourcePoint): boolean {
	return local.xPx >= 0 && local.xPx < grid.widthPx && local.yPx >= 0 && local.yPx < grid.heightPx;
}
