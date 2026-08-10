/**
 * Canonical transform application, inverse, and derived-value math shared by
 * both alignment models. Preview and persistence code must consume these
 * functions rather than reimplementing the formulas.
 */

import type { AlignmentPoint, SerializableTransform } from './types';

/** Determinant threshold below which a 2x2 linear part is treated as singular. */
export const DETERMINANT_TOLERANCE = 1e-12;

export function applyTransform(point: AlignmentPoint, transform: SerializableTransform): AlignmentPoint {
	const [a, b, c, d, e, f] = transform.coefficients;
	return {
		xPx: a * point.xPx + c * point.yPx + e,
		yPx: b * point.xPx + d * point.yPx + f
	};
}

export function transformPoints(
	points: readonly AlignmentPoint[],
	transform: SerializableTransform
): AlignmentPoint[] {
	return points.map((point) => applyTransform(point, transform));
}

/**
 * Returns the inverse transform when invertible, otherwise null. The inverse
 * of `[a b c d e f]` in the xT = a*xS + c*yS + e form is
 * `[d -b -c a (c*f - d*e) (b*e - a*f)] / det`.
 */
export function invertTransform(transform: SerializableTransform): SerializableTransform | null {
	const [a, b, c, d, e, f] = transform.coefficients;
	const determinant = a * d - b * c;
	if (!Number.isFinite(determinant) || Math.abs(determinant) < DETERMINANT_TOLERANCE) {
		return null;
	}
	const invDet = 1 / determinant;
	const coefficients: [number, number, number, number, number, number] = [
		d * invDet,
		-b * invDet,
		-c * invDet,
		a * invDet,
		(c * f - d * e) * invDet,
		(b * e - a * f) * invDet
	];
	return {
		model: transform.model,
		coefficients,
		...deriveTransformValues(coefficients[0], coefficients[1], coefficients[2], coefficients[3])
	};
}

export interface DerivedTransformValues {
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
 * - anisotropy: minor/major ratio in [0, 1] (1 for similarity);
 * - shear: |u.v| / (sigma1*sigma2), the cotangent of the angle between the
 *   mapped axes (0 for similarity, large for strongly sheared maps).
 */
export function deriveTransformValues(a: number, b: number, c: number, d: number): DerivedTransformValues {
	const finite =
		Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c) && Number.isFinite(d);
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
	return {
		isInvertible,
		determinant,
		orientation,
		majorAxisScale,
		minorAxisScale,
		anisotropy,
		shear
	};
}
