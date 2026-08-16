/**
 * Generic source-pose query API (CHSPT-55/51, "Agent D — generic sprite
 * pose").
 *
 * Detection today runs strictly AFTER stitching has flattened every
 * contributing capture into one composite raster, with no memory of which
 * source tile a given composite-space region came from or at what pose
 * (rotation/scale) that source was placed at. `basketTemplateDetection.ts`
 * assumes "captures always render upright and unrotated" -- an assumption
 * that breaks the moment a contributing capture was rotated during
 * stitching (`domain/provenance.ts`'s `SourceTransform` families
 * `'similarity'`/`'affine'`).
 *
 * This module answers one question, generically, for ANY sprite kind
 * (baskets, number badges, tee pads, or a sprite type that doesn't exist
 * yet): "which source capture(s), at what pose, could have produced the
 * pixels at this composite-space location?" It is a pure consumer of the
 * locked `domain/provenance.ts` contract -- `SourceTransform`,
 * `applySourceTransform`/`invertSourceTransform`, `SourceCapture`,
 * `CompositeProvenance.sources` -- and invents no parallel representation of
 * any of those.
 *
 * `coveragePolygon` (each source's transformed crop-rect corners, in
 * composite pixels) is the primary tool: a point-in-polygon test against
 * every source's `coveragePolygon` tells you exactly which source(s) could
 * have contributed a given composite pixel -- a single source in most of the
 * frame, but potentially MULTIPLE sources in overlap regions. Overlap is
 * handled as a real list of contributors, never an arbitrary "winner" pick.
 *
 * Two distinguishable "nothing usable" outcomes, per the ticket's explicit
 * requirement that missing/ambiguous provenance must cause abstention or an
 * explicit unconstrained fallback, never invented pose certainty:
 *
 * - `{ kind: 'unconstrained', reason: 'no-provenance' }` -- the composite has
 *   no `CompositeProvenance` at all (the legacy pre-provenance case). There
 *   is no constraint available; a caller falling back to an unconstrained
 *   full-angle/full-scale search is doing so knowingly, not by accident.
 * - `{ kind: 'contributors', contributors: [] }` -- provenance exists, but no
 *   source's `coveragePolygon` contains the queried location. This is
 *   "definitely no source contributes here", a materially different case
 *   from "we don't know" above.
 */

import type {
	CompositePoint,
	CompositeProvenance,
	SourceCapture,
	SourceRasterPoint,
	SourceTransform
} from '../domain/provenance';
import { applySourceTransform, invertSourceTransform } from '../domain/provenance';

/**
 * One source capture that could have contributed a queried composite-space
 * location, carrying its own `transform` (source-raster-px -> composite-px)
 * alongside the pose descriptors most callers need without re-deriving them.
 */
export interface SourcePoseContributor {
	readonly sourceId: string;
	readonly transform: SourceTransform;
	/** The full `SourceCapture` record (crop, coveragePolygon, paintOrder, ...) for callers that need more than the transform. */
	readonly capture: SourceCapture;
	/**
	 * Orientation of the transform's mapped x-axis, in degrees, normalized to
	 * `[0, 360)`. Exact for `'translation'`/`'similarity'` models (a single
	 * angle fully describes the pose); for a sheared/anisotropic `'affine'`
	 * transform this is only the mapped-x-axis direction, not a value that
	 * alone reconstructs the transform -- see `rotationDegreesForTransform`.
	 */
	readonly rotationDeg: number;
	/**
	 * `(majorAxisScale + minorAxisScale) / 2` -- the exact uniform scale for
	 * `'translation'`/`'similarity'` transforms, an average for anisotropic
	 * `'affine'` ones.
	 */
	readonly approxScale: number;
}

/**
 * The result of a pose query. `'unconstrained'` and an empty `'contributors'`
 * list are deliberately different shapes (not both "empty array") so a
 * caller can never conflate "we have no idea" with "we know for a fact
 * nothing contributes here."
 */
export type SourcePoseQuery =
	| { readonly kind: 'unconstrained'; readonly reason: 'no-provenance' }
	| { readonly kind: 'contributors'; readonly contributors: readonly SourcePoseContributor[] };

/** An axis-aligned composite-space region, e.g. a detector's search window. */
export interface CompositeRegionPx {
	readonly xPx: number;
	readonly yPx: number;
	readonly widthPx: number;
	readonly heightPx: number;
}

function pointInPolygon(point: CompositePoint, polygon: readonly CompositePoint[]): boolean {
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
		const a = polygon[i];
		const b = polygon[j];
		const straddles = a.yPx > point.yPx !== b.yPx > point.yPx;
		if (!straddles) continue;
		const xAtY = ((b.xPx - a.xPx) * (point.yPx - a.yPx)) / (b.yPx - a.yPx) + a.xPx;
		if (point.xPx < xAtY) inside = !inside;
	}
	return inside;
}

function regionCorners(region: CompositeRegionPx): readonly CompositePoint[] {
	return [
		{ xPx: region.xPx, yPx: region.yPx },
		{ xPx: region.xPx + region.widthPx, yPx: region.yPx },
		{ xPx: region.xPx + region.widthPx, yPx: region.yPx + region.heightPx },
		{ xPx: region.xPx, yPx: region.yPx + region.heightPx }
	];
}

function projectPolygon(
	polygon: readonly CompositePoint[],
	axisXPx: number,
	axisYPx: number
): { readonly min: number; readonly max: number } {
	let min = Infinity;
	let max = -Infinity;
	for (const point of polygon) {
		const projection = point.xPx * axisXPx + point.yPx * axisYPx;
		if (projection < min) min = projection;
		if (projection > max) max = projection;
	}
	return { min, max };
}

/** True if every edge normal of `subject` separates `subject` from `other` (i.e. no overlap on that axis alone rules out any overlap). */
function hasSeparatingAxis(subject: readonly CompositePoint[], other: readonly CompositePoint[]): boolean {
	for (let i = 0; i < subject.length; i += 1) {
		const a = subject[i];
		const b = subject[(i + 1) % subject.length];
		const edgeXPx = b.xPx - a.xPx;
		const edgeYPx = b.yPx - a.yPx;
		// Edge normal -- valid as a separating-axis candidate for any simple
		// (convex or not) polygon pair; both `coveragePolygon` (an affine image
		// of a rectangle) and `regionCorners` (a rectangle) are convex in
		// practice, which is what SAT requires for a correct (not just
		// necessary) test.
		const axisXPx = -edgeYPx;
		const axisYPx = edgeXPx;
		const subjectRange = projectPolygon(subject, axisXPx, axisYPx);
		const otherRange = projectPolygon(other, axisXPx, axisYPx);
		if (subjectRange.max < otherRange.min || otherRange.max < subjectRange.min) return true;
	}
	return false;
}

function polygonsOverlap(a: readonly CompositePoint[], b: readonly CompositePoint[]): boolean {
	if (hasSeparatingAxis(a, b)) return false;
	if (hasSeparatingAxis(b, a)) return false;
	return true;
}

/** Normalizes degrees into `[0, 360)`. */
function normalizeDegrees(degrees: number): number {
	const wrapped = degrees % 360;
	return wrapped < 0 ? wrapped + 360 : wrapped;
}

/**
 * The transform's rotation, in degrees. See `SourcePoseContributor.rotationDeg`'s
 * doc comment for the exact-vs-approximate distinction between transform
 * families. Uses `atan2(b, a)` on the transform's own `[a, b, c, d, e, f]`
 * coefficients (the composite-space direction the source's local x-axis maps
 * to), matching `domain/provenance.ts`'s `xOut = a*xIn + c*yIn + e`, `yOut =
 * b*xIn + d*yIn + f` convention.
 */
export function rotationDegreesForTransform(transform: SourceTransform): number {
	const [a, b] = transform.coefficients;
	return normalizeDegrees((Math.atan2(b, a) * 180) / Math.PI);
}

function toContributor(capture: SourceCapture): SourcePoseContributor {
	return {
		sourceId: capture.sourceId,
		transform: capture.transform,
		capture,
		rotationDeg: rotationDegreesForTransform(capture.transform),
		approxScale: (capture.transform.majorAxisScale + capture.transform.minorAxisScale) / 2
	};
}

/**
 * Every source whose `coveragePolygon` contains `point`, in `provenance.sources`
 * order (stable `sourceId` order, not paint order). Returns
 * `{ kind: 'unconstrained', reason: 'no-provenance' }` when `provenance` is
 * absent -- never silently treats a missing composite as "one implicit
 * identity source."
 */
export function queryContributingSources(
	provenance: CompositeProvenance | null | undefined,
	point: CompositePoint
): SourcePoseQuery {
	if (!provenance) return { kind: 'unconstrained', reason: 'no-provenance' };
	const contributors = provenance.sources
		.filter((source) => pointInPolygon(point, source.coveragePolygon))
		.map(toContributor);
	return { kind: 'contributors', contributors };
}

/**
 * Every source whose `coveragePolygon` overlaps `region` at all (convex
 * polygon intersection, not just corner/center sampling), in
 * `provenance.sources` order. Use this instead of `queryContributingSources`
 * when a detector's search window is a small area rather than a single
 * point -- e.g. a candidate's bounding box, or a neighborhood around a
 * grammar-stage anchor.
 */
export function queryContributingSourcesForRegion(
	provenance: CompositeProvenance | null | undefined,
	region: CompositeRegionPx
): SourcePoseQuery {
	if (!provenance) return { kind: 'unconstrained', reason: 'no-provenance' };
	const corners = regionCorners(region);
	const contributors = provenance.sources
		.filter((source) => polygonsOverlap(corners, source.coveragePolygon))
		.map(toContributor);
	return { kind: 'contributors', contributors };
}

/**
 * Maps a KNOWN composite-space point back to pixels within one specific
 * contributing source's raster, via `invertSourceTransform`. Returns `null`
 * when the transform isn't invertible (`transform.isInvertible === false`,
 * or a degenerate/singular case `invertSourceTransform` itself refuses) --
 * never silently falls back to an approximate or identity mapping.
 *
 * This is what a detector doing SOURCE-SPACE detection needs: it already
 * knows (from `queryContributingSources`) which source(s) are in play at a
 * composite location, and needs the pixels in that source's own raster to
 * run the existing upright-only detector against.
 */
export function sourcePointFromComposite(
	point: CompositePoint,
	contributor: Pick<SourcePoseContributor, 'transform'>
): SourceRasterPoint | null {
	const inverse = invertSourceTransform(contributor.transform);
	if (!inverse) return null;
	return applySourceTransform(point, inverse);
}

/**
 * Maps a source-raster point into composite space via the contributor's own
 * `transform` -- a thin, ergonomic wrapper over `domain/provenance.ts`'s
 * `applySourceTransform` for callers already holding a `SourcePoseContributor`.
 * This is the forward direction a detector doing COMPOSITE-SPACE detection
 * with constrained poses needs: given a candidate found in source space (or a
 * pose to test), know where in the composite it corresponds to.
 */
export function compositePointFromSource(
	point: SourceRasterPoint,
	contributor: Pick<SourcePoseContributor, 'transform'>
): CompositePoint {
	return applySourceTransform(point, contributor.transform);
}
