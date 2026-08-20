/**
 * Shared six-coefficient affine math (source px -> output px), extracted
 * from `src/lib/alignment/transform.ts` (P1-003) so both the source-basemap
 * alignment feature and the CHSPT-55 source-provenance/stitch feature apply,
 * invert, and derive descriptive values from the exact same tested code
 * instead of two independently maintained copies.
 *
 * Application convention, shared by every caller: given coefficients
 * `[a, b, c, d, e, f]`,
 *
 *   xOut = a*xIn + c*yIn + e
 *   yOut = b*xIn + d*yIn + f
 *
 * Values are JSON-safe plain numbers; no Konva/canvas matrix objects cross
 * this boundary. This module has no notion of "source"/"target"/"composite"
 * — that naming belongs to each caller's own domain (see
 * `alignment/types.ts` and `domain/provenance.ts`).
 */

export type Affine6Coefficients = readonly [a: number, b: number, c: number, d: number, e: number, f: number];

export interface Affine6Point {
	readonly xPx: number;
	readonly yPx: number;
}

/** Determinant threshold below which a 2x2 linear part is treated as singular. */
export const DETERMINANT_TOLERANCE = 1e-12;

export function applyAffine6(point: Affine6Point, coefficients: Affine6Coefficients): Affine6Point {
	const [a, b, c, d, e, f] = coefficients;
	return {
		xPx: a * point.xPx + c * point.yPx + e,
		yPx: b * point.xPx + d * point.yPx + f
	};
}

export function transformAffine6Points(
	points: readonly Affine6Point[],
	coefficients: Affine6Coefficients
): Affine6Point[] {
	return points.map((point) => applyAffine6(point, coefficients));
}

/**
 * Returns the inverse coefficients when invertible, otherwise null. The
 * inverse of `[a b c d e f]` in the `xOut = a*xIn + c*yIn + e` form is
 * `[d -b -c a (c*f - d*e) (b*e - a*f)] / det`.
 */
export function invertAffine6(coefficients: Affine6Coefficients): Affine6Coefficients | null {
	const [a, b, c, d, e, f] = coefficients;
	const determinant = a * d - b * c;
	if (!Number.isFinite(determinant) || Math.abs(determinant) < DETERMINANT_TOLERANCE) {
		return null;
	}
	const invDet = 1 / determinant;
	return [
		d * invDet,
		-b * invDet,
		-c * invDet,
		a * invDet,
		(c * f - d * e) * invDet,
		(b * e - a * f) * invDet
	];
}

export interface Affine6DerivedValues {
	readonly isInvertible: boolean;
	readonly determinant: number;
	readonly orientation: number;
	readonly majorAxisScale: number;
	readonly minorAxisScale: number;
	readonly anisotropy: number;
	readonly shear: number;
}

/**
 * Derived values for the linear part with rows [a b; c d] (i.e. columns
 * (a, b) and (c, d)):
 *
 * - determinant/orientation: det = a*d - b*c; orientation is its sign;
 * - axis scales: the two singular values, computed in closed form from
 *   trace(A^T A) = a^2 + b^2 + c^2 + d^2 and det^2;
 * - anisotropy: minor/major ratio in [0, 1] (1 for similarity/translation);
 * - shear: |u.v| / (sigma1*sigma2), the cotangent of the angle between the
 *   mapped axes (0 for similarity/translation, large for strongly sheared
 *   maps).
 */
export function deriveAffine6Values(a: number, b: number, c: number, d: number): Affine6DerivedValues {
	const finite = Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c) && Number.isFinite(d);
	const determinant = a * d - b * c;
	const isInvertible = finite && Math.abs(determinant) >= DETERMINANT_TOLERANCE;
	const orientation = finite ? Math.sign(determinant) : 0;
	const trace = a * a + b * b + c * c + d * d;
	const discriminant = Math.max(trace * trace - 4 * determinant * determinant, 0);
	const sqrtDiscriminant = Math.sqrt(discriminant);
	const majorAxisScale = Math.sqrt((trace + sqrtDiscriminant) / 2);
	const minorAxisScale = Math.sqrt(Math.max((trace - sqrtDiscriminant) / 2, 0));
	const scaleProduct = majorAxisScale * minorAxisScale;
	const anisotropy = scaleProduct > 0 ? minorAxisScale / majorAxisScale : 0;
	const shear = scaleProduct > 0 ? Math.abs(a * c + b * d) / scaleProduct : 0;
	return { isInvertible, determinant, orientation, majorAxisScale, minorAxisScale, anisotropy, shear };
}
