/**
 * Strong hole straightness detection: uses orthogonal-regression collinearity
 * (mirrors `old-stuff/src/lib/autoAnnotation/collinearityStraightnessTest.ts`).
 *
 * For a bendless hole with tee, badge, and basket points, fits an orthogonal
 * line through all three, measures the RMS perpendicular distance to that line,
 * normalizes by tee-basket distance to yield a ratio (divergence), and compares
 * to a threshold (default 0.015 = 1.5%).
 *
 * Divergence metric: `rmse / distance(tee, basket)` where rmse is the root mean
 * square of perpendicular distances of tee, badge, basket to their fitted line.
 * A ratio of 0.015 means the badge sits ~1.5% of the hole's length away from the
 * tee-basket line — the owner's spec defines holes with divergence <= 0.015 as
 * "strong" and eligible for auto-accept without review.
 *
 * On 50+ real bendless holes, P90 divergence is ~1.9%; the 0.015 threshold
 * captures holes well below that typical spread.
 */

export interface Point {
	readonly xPx: number;
	readonly yPx: number;
}

export interface StrongHoleInput {
	readonly n: number;
	readonly badge: Point;
	readonly tee: Point | null;
	readonly basket: Point | null;
	readonly bends: readonly Point[];
}

export interface StrongHoleVerdict {
	readonly n: number;
	readonly divergence: number | null; // null when not computable
	readonly strong: boolean;
}

/** Threshold (ratio) below which a hole is considered "strong" and eligible for auto-accept. */
export const STRONG_DIVERGENCE_MAX = 0.015;

/** Euclidean distance between two points (in pixels). */
function distance(a: Point, b: Point): number {
	const dx = b.xPx - a.xPx;
	const dy = b.yPx - a.yPx;
	return Math.sqrt(dx * dx + dy * dy);
}

/** Returns true if two points are the same or very close (preventing degenerate line fits). */
function pointsCoincident(a: Point, b: Point, epsilon = 1e-10): boolean {
	const dx = b.xPx - a.xPx;
	const dy = b.yPx - a.yPx;
	return dx * dx + dy * dy < epsilon * epsilon;
}

/**
 * Fits an orthogonal-regression line through three points (minimizes perpendicular
 * distance, not vertical/horizontal residual) via principal-axis analysis of their
 * covariance, using the closed-form eigenvector angle.
 *
 * Mirrors `old-stuff/src/lib/autoAnnotation/collinearityStraightnessTest.ts`'s
 * `fitOrthogonalLine` logic.
 */
function fitOrthogonalLine(tee: Point, badge: Point, basket: Point) {
	const points = [tee, badge, basket];
	const meanX = (tee.xPx + badge.xPx + basket.xPx) / 3;
	const meanY = (tee.yPx + badge.yPx + basket.yPx) / 3;

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

	// Principal-axis angle: eigenvector of covariance matrix.
	const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
	const dirX = Math.cos(theta);
	const dirY = Math.sin(theta);

	return { meanX, meanY, dirX, dirY };
}

/**
 * Signed perpendicular distance from point to the line passing through
 * (meanX, meanY) in direction (dirX, dirY).
 */
function perpendicularDistanceToLine(
	point: Point,
	meanX: number,
	meanY: number,
	dirX: number,
	dirY: number
): number {
	const dx = point.xPx - meanX;
	const dy = point.yPx - meanY;
	return dx * dirY - dy * dirX; // dot product with perpendicular direction
}

/**
 * Computes RMSE (root mean square error) of perpendicular distances of tee,
 * badge, and basket from their orthogonal-fitted line.
 * Mirrors the return value of `collinearityStraightnessTest` in the reference.
 */
function collinearityRmse(tee: Point, badge: Point, basket: Point): number {
	const line = fitOrthogonalLine(tee, badge, basket);
	const points = [tee, badge, basket];
	let sumSquaredDist = 0;
	for (const p of points) {
		const dist = perpendicularDistanceToLine(p, line.meanX, line.meanY, line.dirX, line.dirY);
		sumSquaredDist += dist * dist;
	}
	return Math.sqrt(sumSquaredDist / 3);
}

/**
 * Evaluates a batch of holes for "strong" straightness.
 *
 * A hole is strong if and only if:
 * - It has a non-null tee AND non-null basket
 * - It has zero bends
 * - Its divergence (rmse normalized by tee-basket distance) is <= divergenceMax
 *
 * If any required component is missing or bends are present, divergence is null
 * and strong is false. Degenerate cases (coincident points, zero-length rays) also
 * return divergence null and strong false, never NaN or thrown errors.
 */
export function evaluateStrongHoles(
	holes: readonly StrongHoleInput[],
	divergenceMax?: number
): StrongHoleVerdict[] {
	const threshold = divergenceMax ?? STRONG_DIVERGENCE_MAX;

	return holes.map((hole) => {
		// Missing tee or basket: not strong, divergence null.
		if (!hole.tee || !hole.basket) {
			return {
				n: hole.n,
				divergence: null,
				strong: false
			};
		}

		// Bends present: not strong, divergence null.
		if (hole.bends.length > 0) {
			return {
				n: hole.n,
				divergence: null,
				strong: false
			};
		}

		// Degenerate cases: tee coincides with badge or basket.
		if (pointsCoincident(hole.tee, hole.badge) || pointsCoincident(hole.tee, hole.basket)) {
			return {
				n: hole.n,
				divergence: null,
				strong: false
			};
		}

		// Zero-length tee-basket vector: not strong, divergence null.
		const teeBaskDist = distance(hole.tee, hole.basket);
		if (teeBaskDist === 0 || !Number.isFinite(teeBaskDist)) {
			return {
				n: hole.n,
				divergence: null,
				strong: false
			};
		}

		// Compute RMSE and normalize by tee-basket distance.
		const rmse = collinearityRmse(hole.tee, hole.badge, hole.basket);
		if (!Number.isFinite(rmse)) {
			return {
				n: hole.n,
				divergence: null,
				strong: false
			};
		}

		const divergence = rmse / teeBaskDist;
		return {
			n: hole.n,
			divergence: divergence > 0 ? divergence : 0, // Clamp to [0, ∞).
			strong: divergence <= threshold
		};
	});
}
