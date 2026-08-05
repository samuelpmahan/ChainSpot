/**
 * Residual calculations and aggregate metrics (P1-003).
 *
 * For each enabled complete pair: transform the source coordinate with the
 * canonical transform, compare against the target coordinate, and return the
 * per-pair residual vector and Euclidean distance in target-image pixels.
 */

import { applyTransform } from './transform';
import type {
	AlignmentPairInput,
	PointCoordinates,
	ResidualMetrics,
	ResidualPair,
	SerializableTransform
} from './types';

export interface ResidualCalculationOptions {
	readonly pairs: readonly AlignmentPairInput[];
	readonly transform: SerializableTransform;
}

export interface ResidualCalculationResult {
	readonly pairs: readonly ResidualPair[];
	readonly metrics: ResidualMetrics;
}

/**
 * Disabled and incomplete pairs are excluded. An empty enabled set returns a
 * defined zero metric record (count 0, maxPairId null) rather than NaN.
 */
export function calculateResiduals(options: ResidualCalculationOptions): ResidualCalculationResult {
	const residualPairs = options.pairs
		.filter((pair) => pair.enabled && pair.target !== null)
		.map((pair) => {
			const expected = applyTransform(pair.source, options.transform);
			const target = pair.target as PointCoordinates;
			const dx = expected.xPx - target.xPx;
			const dy = expected.yPx - target.yPx;
			return {
				pairId: pair.id,
				source: { xPx: pair.source.xPx, yPx: pair.source.yPx },
				target: { xPx: target.xPx, yPx: target.yPx },
				expected,
				dx,
				dy,
				distance: Math.hypot(dx, dy)
			};
		});

	return { pairs: residualPairs, metrics: computeMetrics(residualPairs) };
}

function computeMetrics(residuals: readonly ResidualPair[]): ResidualMetrics {
	if (residuals.length === 0) {
		return {
			count: 0,
			meanDistance: 0,
			medianDistance: 0,
			rmsDistance: 0,
			maxDistance: 0,
			maxPairId: null
		};
	}

	const distances = residuals.map((residual) => residual.distance).sort((a, b) => a - b);
	const count = distances.length;
	const sum = distances.reduce((acc, distance) => acc + distance, 0);
	const meanDistance = sum / count;
	const medianDistance =
		count % 2 === 1
			? distances[(count - 1) / 2]
			: (distances[count / 2 - 1] + distances[count / 2]) / 2;
	const rmsDistance = Math.sqrt(
		distances.reduce((acc, distance) => acc + distance * distance, 0) / count
	);

	// Deterministic "first maximum wins" identity lookup: the maximum
	// distance itself comes from the sorted list; the pair ID is the first
	// pair in input order achieving it.
	let maxDistance = 0;
	let maxPairId: string | null = null;
	for (const residual of residuals) {
		if (residual.distance > maxDistance) {
			maxDistance = residual.distance;
			maxPairId = residual.pairId;
		}
	}

	return {
		count,
		meanDistance,
		medianDistance,
		rmsDistance,
		maxDistance,
		maxPairId
	};
}
