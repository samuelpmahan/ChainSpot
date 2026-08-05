/**
 * Validation and distortion warnings for alignment results (P1-003).
 *
 * Provides the warnings P1-005 consumes: too few enabled complete pairs,
 * non-invertible or reflected transforms, extreme or collapsed axis scales,
 * high anisotropy, high shear, and non-finite coordinates. This is advisory
 * only; estimation failures are typed and returned by the estimators.
 */

import { deriveTransformValues } from './transform';
import type { AlignmentPairInput, SerializableTransform, ValidationWarning } from './types';

export interface ValidationOptions {
	readonly transform: SerializableTransform;
	readonly pairs: readonly AlignmentPairInput[];
	readonly minPairs?: number;
	readonly maxScale?: number;
	readonly maxShear?: number;
}

export function validateTransform(options: ValidationOptions): ValidationWarning[] {
	const { transform, pairs, minPairs = 3, maxScale = 10, maxShear = 2 } = options;
	const warnings: ValidationWarning[] = [];

	const enabledPairs = pairs.filter((pair) => pair.enabled);
	const completePairs = enabledPairs.filter((pair) => pair.target !== null);

	if (completePairs.length < minPairs) {
		warnings.push({
			type: 'INSUFFICIENT_PAIRS',
			message: `Only ${completePairs.length} enabled complete pairs (${minPairs} required)`,
			severity: 'high'
		});
	}

	const [a, b, c, d] = transform.coefficients;
	const derived = deriveTransformValues(a, b, c, d);

	if (!derived.isInvertible) {
		warnings.push({
			type: 'NON_INVERTIBLE',
			message: 'Transform is not invertible (determinant too close to zero)',
			severity: 'high'
		});
	}

	if (derived.orientation < 0) {
		warnings.push({
			type: 'REFLECTION',
			message: 'Transform includes reflection (determinant is negative)',
			severity: 'medium'
		});
	}

	if (derived.majorAxisScale > maxScale) {
		warnings.push({
			type: 'EXTREME_SCALE',
			message: `Major axis scale (${derived.majorAxisScale.toFixed(2)}) exceeds maximum (${maxScale})`,
			severity: 'medium'
		});
	}

	if (derived.minorAxisScale < 1e-6) {
		warnings.push({
			type: 'ZERO_SCALE',
			message: `Minor axis scale (${derived.minorAxisScale.toFixed(6)}) is too small`,
			severity: 'low'
		});
	}

	if (derived.anisotropy < 0.1) {
		warnings.push({
			type: 'HIGH_ANISOTROPY',
			message: `High anisotropy (${(derived.anisotropy * 100).toFixed(1)}%)`,
			severity: 'medium'
		});
	}

	if (Math.abs(derived.shear) > maxShear) {
		warnings.push({
			type: 'HIGH_SHEAR',
			message: `High shear (${Math.abs(derived.shear).toFixed(2)}), maximum is (${maxShear})`,
			severity: 'low'
		});
	}

	const hasNonFinite = enabledPairs.some(
		(pair) =>
			!Number.isFinite(pair.source.xPx) ||
			!Number.isFinite(pair.source.yPx) ||
			(pair.target !== null &&
				(!Number.isFinite(pair.target.xPx) || !Number.isFinite(pair.target.yPx)))
	);
	if (hasNonFinite) {
		warnings.push({
			type: 'NON_FINITE_COORDINATES',
			message: 'Some source or target coordinates are non-finite',
			severity: 'high'
		});
	}

	return warnings;
}
