/**
 * Cheap, purely-geometric straightness pre-check: fits an orthogonal
 * (total-least-squares) line through a hole's tee, number-badge, and basket
 * centroids/endpoint and reports how far those three points sit from
 * collinear.
 *
 * Motivation: production auto-detection already computes all three points
 * for every hole -- `teePadDetection.ts`'s fitted-rectangle center (a hole's
 * `tee: SourcePoint`), `holeNumberDetection.ts`'s badge center (a hole's
 * `numberBadge`), and `basketTemplateDetection.ts`'s bottom-stem-base
 * endpoint (a hole's `basket: SourcePoint`). A straight hole's badge --
 * placed near the tee, at the start of the fairway -- should sit close to
 * the tee-basket line; a bent hole's badge sits off that line by roughly
 * however much the hole doglegs. If that signal separates straight from
 * bent holes well enough, it is a near-free gate ahead of expensive
 * pixel-classification/pathfinding bend detection: no raster work at all,
 * just three already-known points.
 *
 * Ordinary least squares (regressing y on x, or vice versa) is deliberately
 * NOT used here: it picks one axis as "independent" and degenerates
 * (infinite/undefined slope) when points share (or nearly share) a
 * coordinate on that axis -- exactly what a near-vertical hole on the image
 * would trigger routinely. Total least squares (orthogonal regression --
 * minimizing PERPENDICULAR distance to the fitted line, via the principal
 * axis of the three points' covariance) has no preferred axis and handles
 * any orientation, including exactly vertical, uniformly.
 *
 * Evaluation-only: nothing here is wired into `approveHolePieces`,
 * `corridorBendDetection.ts`, or any live editing flow. See
 * `scripts/collinearity-straightness-check.ts` for validation against real,
 * hand-labeled course data.
 */
import type { SourcePoint } from '../domain/project';

/** A unit vector in source-image pixel space (not a point). */
export interface UnitVector2D {
	readonly x: number;
	readonly y: number;
}

/** A line in source-image pixel space: passes through `point`, oriented along unit vector `direction`. */
export interface FittedLine {
	readonly point: SourcePoint;
	readonly direction: UnitVector2D;
}

export interface CollinearityResult {
	/** RMS perpendicular distance (source px) of the three input points to `line`. 0 = exactly collinear. */
	readonly rmse: number;
	readonly line: FittedLine;
}

/** Signed perpendicular distance from `point` to `line` (source px). Magnitude only matters for RMSE; the sign indicates which side of the line the point falls on. */
export function perpendicularDistanceToLine(point: SourcePoint, line: FittedLine): number {
	const dx = point.xPx - line.point.xPx;
	const dy = point.yPx - line.point.yPx;
	return dx * line.direction.y - dy * line.direction.x;
}

/**
 * Fits an orthogonal-regression line through `points` (total least squares:
 * minimizes summed squared PERPENDICULAR distance, not a vertical/horizontal
 * residual) via the principal axis of their covariance -- the direction of
 * greatest spread, i.e. the dominant eigenvector of the 2x2 covariance
 * matrix `[[sxx, sxy], [sxy, syy]]`. Uses the closed-form eigenvector angle
 * `0.5 * atan2(2*sxy, sxx - syy)` rather than an explicit eigendecomposition
 * -- equivalent, but avoids ever dividing by a coordinate spread (`sxx` or
 * `syy`) the way a slope-based OLS fit would, so an exactly vertical or
 * exactly horizontal point set resolves cleanly with no special-casing.
 * Degenerates only when every point is exactly coincident, in which case any
 * direction is equally "correct" and the arbitrary result is harmless (all
 * perpendicular distances are 0 regardless of the direction chosen).
 */
export function fitOrthogonalLine(points: readonly SourcePoint[]): FittedLine {
	if (points.length === 0) throw new Error('fitOrthogonalLine requires at least one point.');
	const n = points.length;
	const meanX = points.reduce((sum, p) => sum + p.xPx, 0) / n;
	const meanY = points.reduce((sum, p) => sum + p.yPx, 0) / n;

	let sxx = 0;
	let syy = 0;
	let sxy = 0;
	for (const p of points) {
		const dx = p.xPx - meanX;
		const dy = p.yPx - meanY;
		sxx += dx * dx;
		syy += dy * dy;
		sxy += dx * dy;
	}

	const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
	return {
		point: { xPx: meanX, yPx: meanY },
		direction: { x: Math.cos(theta), y: Math.sin(theta) }
	};
}

/**
 * The core straightness test: fits an orthogonal line through `tee`,
 * `badge`, and `basket`, then returns the RMSE of their perpendicular
 * distances to it, plus the fitted line itself (in case bend direction/
 * severity turns out useful later). Low RMSE means the three points are
 * nearly collinear -- consistent with a straight hole; high RMSE means the
 * badge sits well off the tee-basket line -- consistent with a dogleg.
 */
export function collinearityStraightnessTest(tee: SourcePoint, badge: SourcePoint, basket: SourcePoint): CollinearityResult {
	const points = [tee, badge, basket];
	const line = fitOrthogonalLine(points);
	const sumSquaredDistance = points.reduce((sum, p) => sum + perpendicularDistanceToLine(p, line) ** 2, 0);
	return { rmse: Math.sqrt(sumSquaredDistance / points.length), line };
}
