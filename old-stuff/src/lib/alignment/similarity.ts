/**
 * Similarity transformation estimator (P1-003).
 *
 * Similarity preserves angles and uniform scale: the fit is a uniform scale
 * plus rotation plus translation. Requires at least two enabled complete
 * pairs with distinct source points and distinct target points; all extra
 * enabled complete pairs participate in an overdetermined least-squares fit.
 *
 * Closed form: center both point sets, then treat the centered coordinates
 * as complex numbers. The least-squares rotation+scale multiplier is
 *   q = sum(b_i * conj(a_i)) / sum(|a_i|^2)
 * which never produces a reflection. If the reflection-allowed fit
 * (q' = sum(b_i * a_i) / sum(|a_i|^2)) is materially better, the data would
 * require an unsupported reflection and the estimation fails.
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

export interface SimilarityEstimationOptions {
	readonly pairs: readonly AlignmentPairInput[];
}

const MIN_PAIRS = 2;
/**
 * Practical reflection margin: fail only when the reflection-allowed fit has
 * less than half the error of the rotation fit. Exact reflection data wins
 * decisively; ordinary noisy data leaves the two fits comparable.
 */
const REFLECTION_IMPROVEMENT_MARGIN = 0.5;

function isCompletePair(
	pair: AlignmentPairInput
): pair is AlignmentPairInput & { target: AlignmentPoint } {
	return pair.target !== null;
}

export function estimateSimilarity(
	options: SimilarityEstimationOptions
): EstimationResult | EstimationFailure {
	const enabledPairs = options.pairs.filter((pair) => pair.enabled);
	const completePairs = enabledPairs.filter(isCompletePair);

	if (hasNonFiniteCoordinates(enabledPairs)) {
		return failure(AlignmentFailureReason.NON_FINITE_COORDINATES, enabledPairs.length);
	}
	if (completePairs.length < MIN_PAIRS) {
		return failure(AlignmentFailureReason.INSUFFICIENT_PAIRS, completePairs.length);
	}
	if (!hasSpread(completePairs)) {
		return failure(AlignmentFailureReason.ZERO_SPREAD, completePairs.length);
	}

	const { centroidSource, centroidTarget } = centeredSums(completePairs);
	const mx = centroidSource.xPx / completePairs.length;
	const my = centroidSource.yPx / completePairs.length;
	const Mx = centroidTarget.xPx / completePairs.length;
	const My = centroidTarget.yPx / completePairs.length;

	let sumSourceNorm2 = 0;
	let sumDot = 0;
	let sumCross = 0;
	let sumReflectionDot = 0;
	let sumReflectionCross = 0;
	let sumTargetNorm2 = 0;
	for (const pair of completePairs) {
		const u = pair.source.xPx - mx;
		const v = pair.source.yPx - my;
		const pu = pair.target.xPx - Mx;
		const pv = pair.target.yPx - My;
		sumSourceNorm2 += u * u + v * v;
		sumTargetNorm2 += pu * pu + pv * pv;
		sumDot += pu * u + pv * v;
		sumCross += pv * u - pu * v;
		sumReflectionDot += pu * u - pv * v;
		sumReflectionCross += pv * u + pu * v;
	}

	if (sumSourceNorm2 <= 0) {
		return failure(AlignmentFailureReason.ZERO_SPREAD, completePairs.length);
	}

	// Reflection detection: compare the rotation-fit error with the
	// reflection-allowed fit error (both in closed form via the complex
	// regression identity sum(|b|^2) - |sum(b*conj(a))|^2 / sum(|a|^2)).
	const rotationError = Math.max(
		sumTargetNorm2 - (sumDot * sumDot + sumCross * sumCross) / sumSourceNorm2,
		0
	);
	const reflectionError = Math.max(
		sumTargetNorm2 -
			(sumReflectionDot * sumReflectionDot + sumReflectionCross * sumReflectionCross) /
				sumSourceNorm2,
		0
	);
	// Two correspondences define only one directed segment. A rotation+scale can
	// always map that segment exactly, so two points cannot distinguish a true
	// reflection from ordinary floating-point noise in the closed-form errors.
	// Require a third observation before rejecting the fit as mirrored.
	if (
		completePairs.length >= 3 &&
		reflectionError < rotationError * REFLECTION_IMPROVEMENT_MARGIN
	) {
		return failure(AlignmentFailureReason.REFLECTION_REQUIRED, completePairs.length);
	}

	const qr = sumDot / sumSourceNorm2;
	const qi = sumCross / sumSourceNorm2;
	// complex multiplication by (qr + i*qi): x' = qr*x - qi*y, y' = qi*x + qr*y
	const a = qr;
	const b = qi;
	const c = -qi;
	const d = qr;
	const e = Mx - a * mx - c * my;
	const f = My - b * mx - d * my;

	const coefficients: [number, number, number, number, number, number] = [a, b, c, d, e, f];
	if (!coefficients.every(Number.isFinite)) {
		return failure(AlignmentFailureReason.NUMERICAL_SOLVE_FAILURE, completePairs.length);
	}

	const transform = {
		model: 'similarity' as const,
		coefficients,
		...deriveTransformValues(a, b, c, d)
	};

	const { pairs: residuals, metrics } = calculateResiduals({ pairs: completePairs, transform });
	return {
		model: 'similarity',
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

function hasSpread(pairs: readonly (AlignmentPairInput & { target: AlignmentPoint })[]): boolean {
	const sourceKeys = new Set(pairs.map((pair) => `${pair.source.xPx},${pair.source.yPx}`));
	const targetKeys = new Set(pairs.map((pair) => `${pair.target.xPx},${pair.target.yPx}`));
	return sourceKeys.size >= MIN_PAIRS && targetKeys.size >= MIN_PAIRS;
}

function centeredSums(pairs: readonly (AlignmentPairInput & { target: AlignmentPoint })[]): {
	centroidSource: AlignmentPoint;
	centroidTarget: AlignmentPoint;
} {
	let sourceX = 0;
	let sourceY = 0;
	let targetX = 0;
	let targetY = 0;
	for (const pair of pairs) {
		sourceX += pair.source.xPx;
		sourceY += pair.source.yPx;
		targetX += pair.target.xPx;
		targetY += pair.target.yPx;
	}
	return {
		centroidSource: { xPx: sourceX, yPx: sourceY },
		centroidTarget: { xPx: targetX, yPx: targetY }
	};
}

function failure(
	reason: EstimationFailure['reason'],
	availablePairs: number
): EstimationFailure {
	return {
		model: 'similarity',
		reason,
		requiredPairs: MIN_PAIRS,
		availablePairs
	};
}

