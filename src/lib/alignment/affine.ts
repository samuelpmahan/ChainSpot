/**
 * Flexible affine transformation estimator (P1-003).
 *
 * Full six-coefficient affine fit supporting translation, rotation,
 * independent axis scale, and shear. Requires at least three enabled complete
 * pairs with non-collinear source geometry; all extra enabled complete pairs
 * participate in an overdetermined least-squares fit.
 *
 * Solver: center both point sets and solve the resulting 2x2 normal
 * equations for the linear part (the two output rows decouple),
 *   G [a c]^T = [sum(p*u) sum(p*v)]^T
 *   G [b d]^T = [sum(q*u) sum(q*v)]^T
 * with G = [[sum(u^2) sum(u*v)] [sum(u*v) sum(v^2)]] over the centered
 * source coordinates, then recover the translation from the centroids.
 * Centering avoids the conditioning problems of uncentered normal equations.
 * G is singular exactly when the source geometry is collinear; a relative
 * tolerance detects near-singular geometry.
 */

import { deriveTransformValues } from './transform';
import { calculateResiduals } from './residuals';
import {
	AlignmentFailureReason,
	type AlignmentPairInput,
	type AlignmentPoint,
	type EstimationFailure,
	type EstimationResult
} from './types';

export interface AffineEstimationOptions {
	readonly pairs: readonly AlignmentPairInput[];
}

const MIN_PAIRS = 3;
/**
 * Practical ill-conditioning threshold: the Gram determinant must retain at
 * least 1e-9 of its product scale, otherwise the source geometry is treated
 * as collinear/singular.
 */
const SINGULARITY_RELATIVE_TOLERANCE = 1e-9;

function isCompletePair(
	pair: AlignmentPairInput
): pair is AlignmentPairInput & { target: AlignmentPoint } {
	return pair.target !== null;
}

export function estimateAffine(
	options: AffineEstimationOptions
): EstimationResult | EstimationFailure {
	const enabledPairs = options.pairs.filter((pair) => pair.enabled);
	const completePairs = enabledPairs.filter(isCompletePair);

	if (hasNonFiniteCoordinates(enabledPairs)) {
		return failure(AlignmentFailureReason.NON_FINITE_COORDINATES, enabledPairs.length);
	}
	if (completePairs.length < MIN_PAIRS) {
		return failure(AlignmentFailureReason.INSUFFICIENT_PAIRS, completePairs.length);
	}
	if (!hasNonCollinearSources(completePairs)) {
		return failure(AlignmentFailureReason.COLLINEAR_GEOMETRY, completePairs.length);
	}

	let sourceX = 0;
	let sourceY = 0;
	let targetX = 0;
	let targetY = 0;
	for (const pair of completePairs) {
		sourceX += pair.source.xPx;
		sourceY += pair.source.yPx;
		targetX += pair.target.xPx;
		targetY += pair.target.yPx;
	}
	const n = completePairs.length;
	const mx = sourceX / n;
	const my = sourceY / n;
	const Mx = targetX / n;
	const My = targetY / n;

	let sumU2 = 0;
	let sumV2 = 0;
	let sumUV = 0;
	let sumPU = 0;
	let sumPV = 0;
	let sumQU = 0;
	let sumQV = 0;
	for (const pair of completePairs) {
		const u = pair.source.xPx - mx;
		const v = pair.source.yPx - my;
		const p = pair.target.xPx - Mx;
		const q = pair.target.yPx - My;
		sumU2 += u * u;
		sumV2 += v * v;
		sumUV += u * v;
		sumPU += p * u;
		sumPV += p * v;
		sumQU += q * u;
		sumQV += q * v;
	}

	const detG = sumU2 * sumV2 - sumUV * sumUV;
	if (detG <= SINGULARITY_RELATIVE_TOLERANCE * sumU2 * sumV2) {
		return failure(AlignmentFailureReason.COLLINEAR_GEOMETRY, completePairs.length);
	}

	const invDetG = 1 / detG;
	const a = (sumPU * sumV2 - sumPV * sumUV) * invDetG;
	const c = (sumPV * sumU2 - sumPU * sumUV) * invDetG;
	const b = (sumQU * sumV2 - sumQV * sumUV) * invDetG;
	const d = (sumQV * sumU2 - sumQU * sumUV) * invDetG;
	const e = Mx - a * mx - c * my;
	const f = My - b * mx - d * my;

	const coefficients: [number, number, number, number, number, number] = [a, b, c, d, e, f];
	if (!coefficients.every(Number.isFinite)) {
		return failure(AlignmentFailureReason.NUMERICAL_SOLVE_FAILURE, completePairs.length);
	}

	const transform = {
		model: 'affine' as const,
		coefficients,
		...deriveTransformValues(a, b, c, d)
	};

	if (!transform.isInvertible) {
		return failure(AlignmentFailureReason.NON_INVERTIBLE, completePairs.length);
	}

	const { pairs: residuals, metrics } = calculateResiduals({ pairs: completePairs, transform });
	return {
		model: 'affine',
		transform,
		residuals,
		metrics,
		usedPairIds: completePairs.map((pair) => pair.id)
	};
}

function hasNonFiniteCoordinates(pairs: readonly AlignmentPairInput[]): boolean {
	return pairs.some(
		(pair) =>
			!Number.isFinite(pair.source.xPx) ||
			!Number.isFinite(pair.source.yPx) ||
			(pair.target !== null &&
				(!Number.isFinite(pair.target.xPx) || !Number.isFinite(pair.target.yPx)))
	);
}

function hasNonCollinearSources(
	pairs: readonly (AlignmentPairInput & { target: AlignmentPoint })[]
): boolean {
	const keys = new Set(pairs.map((pair) => `${pair.source.xPx},${pair.source.yPx}`));
	return keys.size >= MIN_PAIRS;
}

function failure(reason: EstimationFailure['reason'], availablePairs: number): EstimationFailure {
	return {
		model: 'affine',
		reason,
		requiredPairs: MIN_PAIRS,
		availablePairs
	};
}
