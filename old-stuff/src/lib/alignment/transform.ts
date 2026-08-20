/**
 * Canonical transform application, inverse, and derived-value math shared by
 * both alignment models. Preview and persistence code must consume these
 * functions rather than reimplementing the formulas.
 *
 * The underlying six-coefficient math is `src/lib/geometry/affine6.ts`,
 * shared with the CHSPT-55 source-provenance/stitch feature
 * (`domain/provenance.ts`) so both features apply/invert/derive from one
 * tested implementation. This module's own public API and behavior are
 * unchanged by that extraction — it only re-expresses `SerializableTransform`
 * in terms of the shared primitives.
 */

import { applyAffine6, deriveAffine6Values, invertAffine6 } from '../geometry/affine6';
import type { Affine6DerivedValues } from '../geometry/affine6';
import type { AlignmentPoint, SerializableTransform } from './types';

/** Determinant threshold below which a 2x2 linear part is treated as singular. Re-exported from `geometry/affine6.ts` for existing callers. */
export { DETERMINANT_TOLERANCE } from '../geometry/affine6';

export function applyTransform(point: AlignmentPoint, transform: SerializableTransform): AlignmentPoint {
	return applyAffine6(point, transform.coefficients);
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
	const coefficients = invertAffine6(transform.coefficients);
	if (!coefficients) return null;
	return {
		model: transform.model,
		coefficients,
		...deriveTransformValues(coefficients[0], coefficients[1], coefficients[2], coefficients[3])
	};
}

export type DerivedTransformValues = Affine6DerivedValues;

/**
 * Derived values for the linear part with rows [a b; c d] (i.e. columns
 * (a, b) and (c, d)): determinant/orientation, the two singular-value axis
 * scales, anisotropy, and shear. See `geometry/affine6.ts`'s
 * `deriveAffine6Values` for the full derivation.
 */
export function deriveTransformValues(a: number, b: number, c: number, d: number): DerivedTransformValues {
	return deriveAffine6Values(a, b, c, d);
}
