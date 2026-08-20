/**
 * ChainSpot course-shape signature (Course Memory, stage 3).
 *
 * Pure geometry over already-detected, already-labeled points: no Svelte,
 * Konva, worker, or browser API beyond `crypto.subtle` (via the existing
 * `sha256Hex`/`HashBytes` convention from `imageIntake.ts` — no hashing
 * package is added, matching this project's stated policy). This module
 * never touches IndexedDB, CV detectors, or UI state.
 *
 * The insight that makes "does this new screenshot show a course I've seen
 * before" tractable: CV-detected hole-number badges already carry a resolved
 * hole number (OCR + Hungarian assignment in `autoAnnotation/courseGrammar.ts`),
 * and basket ownership is resolved to the same hole numbers. Two point sets
 * from two different screenshots of the same course therefore have a known
 * correspondence (H1 -> H1, H2 -> H2, ...) rather than requiring blind
 * point-cloud registration — `matchSignatures` below feeds that
 * correspondence straight into the existing `alignment/` transform-fitting
 * module.
 *
 * Two independent matching paths:
 *
 * - `computeSignatureDescriptor` + `hashSignatureDescriptor` produce a coarse
 *   pre-filter hash: translate to centroid, scale-normalize by RMS spread,
 *   rotate so the smallest-present hole number lands on the positive x-axis
 *   (a deterministic reference — no PCA sign ambiguity, since hole numbers
 *   give an unambiguous anchor), then quantize before hashing. This hash is
 *   NOT expected to match across two different screenshot sessions of the
 *   same course in general: a different crop changes which hole number is
 *   "smallest present," which changes the rotation reference and therefore
 *   the hash even for a geometrically identical course. It exists purely to
 *   short-circuit the cheap case (re-running detection on the same or a
 *   near-identical image) before paying for a fuzzy scan.
 *
 * - `matchSignatures` is the primary, expected-to-fire path for the real
 *   product scenario (same course, a different round, a differently cropped
 *   or zoomed screenshot). It fits a similarity transform (falling back to
 *   affine on a large-enough overlap) from one course's badge/basket
 *   positions to another's, using `(holeNumber, kind)` as the correspondence
 *   key, then scores the fit's residual against the target course's own
 *   geometric spread. The `alignment/` module fits an ordinary least-squares
 *   transform over every supplied pair with no outlier rejection, so this
 *   module adds its own drop-and-refit loop around it.
 *
 * Every threshold below (`MIN_SIGNATURE_HOLES`, `HASH_QUANTIZATION_STEP`,
 * `MIN_OVERLAP_HOLES`, `MIN_OVERLAP_FRACTION`, `CONFIDENT_MATCH_NORMALIZED_RMS`,
 * `OUTLIER_PRUNE_MAX_ITERATIONS`, `OUTLIER_PRUNE_MIN_REMAINING_PAIRS`,
 * `AFFINE_FALLBACK_MIN_OVERLAP`) is a principled starting point picked from
 * first principles, not a value validated against real repeated-course
 * fixtures — treat this as mechanism, not settled architecture, and expect
 * these constants (not the shape of the algorithm) to move once real data
 * exists.
 */
import { sha256Hex } from './imageIntake';
import type { HashBytes, Sha256Hex } from './imageIntake';
import { estimateAffine } from './alignment/affine';
import { estimateSimilarity } from './alignment/similarity';
import type { AlignmentPairInput, EstimationResult, SerializableTransform } from './alignment/types';
import type { PointCoordinates } from './domain/project';

/** A point resolved to its hole number, in one image's raw pixel space. */
export interface LabeledPoint {
	readonly holeNumber: number;
	readonly xPx: number;
	readonly yPx: number;
}

export interface CourseSignatureInput {
	readonly badges: readonly LabeledPoint[];
	readonly baskets: readonly LabeledPoint[];
}

/** Below this many distinct badge-labeled holes, any similarity fit is a near-tautology, not evidence. */
export const MIN_SIGNATURE_HOLES = 6;
/** Normalized-coordinate rounding step before hashing: 1% of the course's own RMS spread. */
export const HASH_QUANTIZATION_STEP = 0.01;

export const MIN_OVERLAP_HOLES = 6;
export const MIN_OVERLAP_FRACTION = 0.5;
export const CONFIDENT_MATCH_NORMALIZED_RMS = 0.06;
export const OUTLIER_PRUNE_MAX_ITERATIONS = 3;
export const OUTLIER_PRUNE_MIN_REMAINING_PAIRS = 5;
export const AFFINE_FALLBACK_MIN_OVERLAP = 9;

type PointKind = 'badge' | 'basket';

interface CombinedPoint {
	readonly holeNumber: number;
	readonly kind: PointKind;
	readonly xPx: number;
	readonly yPx: number;
}

export type SignatureDescriptor =
	| {
			readonly ok: true;
			readonly holeNumbers: readonly number[];
			readonly points: readonly {
				readonly holeNumber: number;
				readonly kind: PointKind;
				readonly xNorm: number;
				readonly yNorm: number;
			}[];
	  }
	| { readonly ok: false; readonly reason: 'insufficient-holes' | 'degenerate-spread' };

export interface SignatureMatchResult {
	readonly matched: boolean;
	readonly transform: SerializableTransform | null;
	readonly normalizedRms: number;
	/** 0..1; 0 when `matched` is false. */
	readonly confidence: number;
	readonly usedHoleNumbers: readonly number[];
	/** Hole numbers pruned as outliers during fitting. */
	readonly droppedHoleNumbers: readonly number[];
	readonly model: 'similarity' | 'affine' | null;
}

function combinePoints(input: CourseSignatureInput): CombinedPoint[] {
	return [
		...input.badges.map((point) => ({ holeNumber: point.holeNumber, kind: 'badge' as const, xPx: point.xPx, yPx: point.yPx })),
		...input.baskets.map((point) => ({ holeNumber: point.holeNumber, kind: 'basket' as const, xPx: point.xPx, yPx: point.yPx }))
	];
}

function centroidOf(points: readonly PointCoordinates[]): PointCoordinates {
	if (points.length === 0) return { xPx: 0, yPx: 0 };
	let sumX = 0;
	let sumY = 0;
	for (const point of points) {
		sumX += point.xPx;
		sumY += point.yPx;
	}
	return { xPx: sumX / points.length, yPx: sumY / points.length };
}

/**
 * RMS distance from the point set's own centroid — the single definition of
 * "spread" shared by descriptor scale normalization and match-residual
 * normalization, so the two never drift apart.
 */
export function spreadOf(points: readonly PointCoordinates[]): number {
	if (points.length === 0) return 0;
	const centroid = centroidOf(points);
	let sumSquares = 0;
	for (const point of points) {
		const dx = point.xPx - centroid.xPx;
		const dy = point.yPx - centroid.yPx;
		sumSquares += dx * dx + dy * dy;
	}
	return Math.sqrt(sumSquares / points.length);
}

/** Rounds to the quantization step and squashes -0 to 0, so equal shapes always compare byte-for-byte equal. */
function quantize(value: number): number {
	return Math.round(value / HASH_QUANTIZATION_STEP) * HASH_QUANTIZATION_STEP + 0;
}

/** Squashes -0 to 0 before formatting so the hash never depends on IEEE 754 sign-of-zero. */
function formatFixed(value: number): string {
	return (value + 0).toFixed(2);
}

/**
 * Normalizes a labeled badge+basket point set into a translation/scale/
 * rotation-canonical descriptor. Rotation is anchored on the point with the
 * smallest present hole number (badge preferred over basket on a tie),
 * deterministic and unambiguous because every point already carries a
 * resolved hole number — unlike anonymous point-cloud canonicalization,
 * there is no PCA sign-flip ambiguity to resolve.
 */
export function computeSignatureDescriptor(input: CourseSignatureInput): SignatureDescriptor {
	const distinctBadgeHoles = new Set(input.badges.map((badge) => badge.holeNumber));
	if (distinctBadgeHoles.size < MIN_SIGNATURE_HOLES) {
		return { ok: false, reason: 'insufficient-holes' };
	}

	const combined = combinePoints(input);
	const centroid = centroidOf(combined);
	const centered = combined.map((point) => ({ ...point, xPx: point.xPx - centroid.xPx, yPx: point.yPx - centroid.yPx }));
	const scale = spreadOf(centered);
	if (scale < 1e-6) {
		return { ok: false, reason: 'degenerate-spread' };
	}

	const minHoleNumber = Math.min(...combined.map((point) => point.holeNumber));
	const reference =
		centered.find((point) => point.holeNumber === minHoleNumber && point.kind === 'badge') ??
		(centered.find((point) => point.holeNumber === minHoleNumber) as (typeof centered)[number]);
	const angle = Math.atan2(reference.yPx, reference.xPx);
	const cosA = Math.cos(angle);
	const sinA = Math.sin(angle);

	const points = centered
		.map((point) => {
			const rotatedX = point.xPx * cosA + point.yPx * sinA;
			const rotatedY = -point.xPx * sinA + point.yPx * cosA;
			return {
				holeNumber: point.holeNumber,
				kind: point.kind,
				xNorm: quantize(rotatedX / scale),
				yNorm: quantize(rotatedY / scale)
			};
		})
		.sort((a, b) => a.holeNumber - b.holeNumber || a.kind.localeCompare(b.kind));

	return {
		ok: true,
		holeNumbers: [...new Set(combined.map((point) => point.holeNumber))].sort((a, b) => a - b),
		points
	};
}

/** Hashes a valid descriptor's canonical, order-independent serialization via `sha256Hex` (or an injected `hash`). */
export function hashSignatureDescriptor(
	descriptor: SignatureDescriptor & { ok: true },
	hash: HashBytes = sha256Hex
): Promise<Sha256Hex> {
	const canonical = JSON.stringify({
		holeNumbers: descriptor.holeNumbers,
		points: descriptor.points.map((point) => ({
			holeNumber: point.holeNumber,
			kind: point.kind,
			xNorm: formatFixed(point.xNorm),
			yNorm: formatFixed(point.yNorm)
		}))
	});
	return hash(new TextEncoder().encode(canonical));
}

function pairKey(holeNumber: number, kind: PointKind): string {
	return `${holeNumber}:${kind}`;
}

function holeNumberFromPairKey(key: string): number {
	return Number.parseInt(key.split(':')[0], 10);
}

interface PruneAttempt {
	readonly ok: boolean;
	readonly result: EstimationResult | null;
	readonly normalizedRms: number;
	readonly pairsUsed: readonly AlignmentPairInput[];
	readonly droppedIds: readonly string[];
}

/**
 * The alignment estimators fit an ordinary least-squares transform over
 * every supplied pair with no outlier rejection (by design — see
 * `alignment/similarity.ts`/`affine.ts`). This loop adds a drop-and-refit
 * pass on top: while the fit's residual (normalized by the target's own
 * spread) exceeds the match threshold, drop the single worst-residual pair
 * and refit, stopping once the threshold is met, the iteration budget is
 * spent, or too few pairs would remain to keep fitting meaningfully.
 */
function fitWithOutlierPruning(
	estimator: (options: { pairs: readonly AlignmentPairInput[] }) => EstimationResult | { reason: string },
	initialPairs: readonly AlignmentPairInput[],
	targetSpread: number
): PruneAttempt {
	let currentPairs = initialPairs;
	const droppedIds: string[] = [];
	let iterations = 0;

	while (true) {
		const estimate = estimator({ pairs: currentPairs });
		if (!('transform' in estimate)) {
			return { ok: false, result: null, normalizedRms: Number.POSITIVE_INFINITY, pairsUsed: currentPairs, droppedIds };
		}
		const normalizedRms =
			targetSpread > 1e-9 ? estimate.metrics.rmsDistance / targetSpread : Number.POSITIVE_INFINITY;
		const withinThreshold = normalizedRms <= CONFIDENT_MATCH_NORMALIZED_RMS;
		const budgetSpent = iterations >= OUTLIER_PRUNE_MAX_ITERATIONS;
		const worstId = estimate.metrics.maxPairId;
		const canPruneFurther = worstId !== null && currentPairs.length - 1 >= OUTLIER_PRUNE_MIN_REMAINING_PAIRS;
		if (withinThreshold || budgetSpent || !canPruneFurther) {
			return { ok: true, result: estimate, normalizedRms, pairsUsed: currentPairs, droppedIds };
		}
		droppedIds.push(worstId as string);
		currentPairs = currentPairs.filter((pair) => pair.id !== worstId);
		iterations += 1;
	}
}

/**
 * Fits a transform from `source`'s badge/basket positions to `target`'s,
 * using `(holeNumber, kind)` as the correspondence key, and scores the fit
 * against `target`'s own geometric spread. This is the primary matching path
 * for the product's real scenario: a differently cropped/zoomed screenshot
 * of the same course. On a confident match, `transform` maps `source` pixel
 * coordinates into `target` pixel coordinates — the same direction needed to
 * import a previously-annotated course's geometry into a newly uploaded
 * screenshot.
 */
export function matchSignatures(source: CourseSignatureInput, target: CourseSignatureInput): SignatureMatchResult {
	const sourceCombined = combinePoints(source);
	const targetCombined = combinePoints(target);
	const targetByKey = new Map(targetCombined.map((point) => [pairKey(point.holeNumber, point.kind), point]));

	const pairs: AlignmentPairInput[] = [];
	for (const point of sourceCombined) {
		const key = pairKey(point.holeNumber, point.kind);
		const targetPoint = targetByKey.get(key);
		if (!targetPoint) continue;
		pairs.push({
			id: key,
			enabled: true,
			source: { xPx: point.xPx, yPx: point.yPx },
			target: { xPx: targetPoint.xPx, yPx: targetPoint.yPx }
		});
	}

	const overlapHoleNumbers = new Set(pairs.map((pair) => holeNumberFromPairKey(pair.id)));
	const sourceHoleCount = new Set(sourceCombined.map((point) => point.holeNumber)).size;
	const targetHoleCount = new Set(targetCombined.map((point) => point.holeNumber)).size;
	const minSideHoleCount = Math.min(sourceHoleCount, targetHoleCount);

	const noMatch: SignatureMatchResult = {
		matched: false,
		transform: null,
		normalizedRms: Number.POSITIVE_INFINITY,
		confidence: 0,
		usedHoleNumbers: [],
		droppedHoleNumbers: [],
		model: null
	};

	if (
		overlapHoleNumbers.size < MIN_OVERLAP_HOLES ||
		overlapHoleNumbers.size < MIN_OVERLAP_FRACTION * minSideHoleCount
	) {
		return noMatch;
	}

	const targetSpread = spreadOf(targetCombined);

	let chosen: (PruneAttempt & { model: 'similarity' | 'affine' }) | null = null;
	const similarityFit = fitWithOutlierPruning(estimateSimilarity, pairs, targetSpread);
	if (similarityFit.ok) chosen = { ...similarityFit, model: 'similarity' };

	const needsAffineFallback =
		(!chosen || chosen.normalizedRms > CONFIDENT_MATCH_NORMALIZED_RMS) &&
		overlapHoleNumbers.size >= AFFINE_FALLBACK_MIN_OVERLAP;
	if (needsAffineFallback) {
		const affineFit = fitWithOutlierPruning(estimateAffine, pairs, targetSpread);
		if (affineFit.ok && (!chosen || affineFit.normalizedRms < chosen.normalizedRms)) {
			chosen = { ...affineFit, model: 'affine' };
		}
	}

	if (!chosen || !chosen.result) return noMatch;

	const matched = chosen.normalizedRms <= CONFIDENT_MATCH_NORMALIZED_RMS;
	const confidence = matched ? clamp01(1 - chosen.normalizedRms / CONFIDENT_MATCH_NORMALIZED_RMS) : 0;
	const usedHoleNumbers = [...new Set(chosen.pairsUsed.map((pair) => holeNumberFromPairKey(pair.id)))].sort(
		(a, b) => a - b
	);
	const droppedHoleNumbers = [...new Set(chosen.droppedIds.map(holeNumberFromPairKey))].sort((a, b) => a - b);

	return {
		matched,
		transform: matched ? chosen.result.transform : null,
		normalizedRms: chosen.normalizedRms,
		confidence,
		usedHoleNumbers,
		droppedHoleNumbers,
		model: matched ? chosen.model : null
	};
}

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}
