/**
 * Course grammar / endpoint ownership.
 *
 * This module deliberately knows nothing about pixels, OpenCV, or Svelte.  It
 * turns three independently-detected vocabularies into reviewable hole
 * proposals.  All coordinates are source-image pixels.
 *
 * The ownership grammar is the one validated by the static course probe:
 *
 *   tee  ->  own number badge  ->  basket
 *
 * Number badges own hole labels.  Baskets are the more reliable detector, so
 * a preliminary badge-to-basket distance pass runs first to learn each
 * badge's basket direction.  Tees are then matched one-to-one to their owned
 * badge by distance plus a penalty when the tee lies on the *same* side of
 * the badge as its (preliminary) basket — i.e. walking backward from the
 * basket, through the badge, to find the tee on the far side.  This resolves
 * dense clusters where a neighboring hole's badge sits nominally closer to
 * this hole's tee than its own badge does.  Baskets are then matched
 * in two ownership tiers: independently AUTO-owned tees reserve their
 * polarity-consistent basket first, then REVIEW/unresolved holes solve the
 * remaining vocabulary from badge distance and the trusted course-distance
 * distribution. This prevents one wrong REVIEW tee from permuting several
 * otherwise-correct native baskets.
 */

import type { Candidate } from '../cv/types';

export const DEFAULT_COURSE_HOLE_NUMBERS: readonly number[] = Array.from(
	{ length: 18 }, (_, index) => index + 1
);

/**
 * A source-image point emitted by an endpoint detector. `score` (from
 * `Candidate`) is the compatibility field for detectors that call confidence
 * `score` rather than `confidence`.
 */
export interface CoursePointCandidate extends Candidate {
	/** Normalized detector confidence when available (0..1). */
	readonly confidence?: number;
	/**
	 * The candidate's position in the caller's own raw detector-output array
	 * (e.g. `CourseDetectionResult.tees`/`.baskets`), when that differs from
	 * its position in the array passed to `associateCourseGrammar` here.
	 * Some callers pass a compacted/reordered array (one entry per resolved
	 * hole, not one per raw candidate) — array position within *that* array
	 * is not a stable identifier a downstream consumer can index the raw
	 * candidate list with. When present, this is used instead of array
	 * position for every `candidateIndex` this module reports, so those
	 * reports stay a correct raw-array index no matter how the caller's own
	 * array is shaped.
	 */
	readonly candidateIndex?: number;
}

/**
 * A tee candidate whose ownership was established before global course
 * grammar. Explicit ownership is a hard constraint: grammar may leave it
 * unassigned, but may never give it to another hole.
 */
export interface CourseTeeCandidate extends CoursePointCandidate {
	readonly holeNumber?: number;
	readonly bootstrapDecision?: 'auto' | 'review';
}

/**
 * A basket candidate recovered by the occlusion-tolerant fallback
 * (`basketOcclusionRecovery.ts`) instead of the primary template matcher.
 * Mirrors `CourseTeeCandidate.bootstrapDecision`: a masked/partial-template
 * match is real local evidence, but never full-strength evidence, so it is
 * capped to REVIEW here rather than allowed to reach AUTO/`ready` on its own
 * geometry score. Ordinary primary-detection baskets leave this undefined
 * and are scored exactly as before.
 */
export interface CourseBasketCandidate extends CoursePointCandidate {
	readonly bootstrapDecision?: 'auto' | 'review';
}

/** One possible digit interpretation for a located number-badge glyph. */
export interface NumberBadgeLabelScore {
	readonly holeNumber: number;
	readonly confidence: number;
}

/**
 * A located hole-number badge.  `holeNumber` is sufficient for detectors that
 * already recognize one label.  `labelScores` supports the stronger probe
 * behaviour: located badge clusters are assigned to 1..18 globally from their
 * glyph scores, rather than trusting duplicate local labels.
 */
export interface CourseNumberBadgeCandidate extends CoursePointCandidate {
	readonly holeNumber?: number;
	readonly labelScores?: readonly NumberBadgeLabelScore[];
	readonly widthPx?: number;
	readonly heightPx?: number;
}

export interface CourseGrammarInput {
	readonly numberBadges: readonly CourseNumberBadgeCandidate[];
	readonly tees: readonly CourseTeeCandidate[];
	/** Basket coordinates must be the basket stem/base, not icon centre. */
	readonly baskets: readonly CourseBasketCandidate[];
	/** Defaults to the standard 1..18 course. */
	readonly holeNumbers?: readonly number[];
	/**
	 * Matches the proven static parser's 80 px opposite-direction penalty,
	 * applied both when walking backward from a preliminary basket to find a
	 * tee and when finally placing a basket against its tee.  It is
	 * intentionally an option for unusually small or large source rasters.
	 */
	readonly basketPolarityPenaltyPx?: number;
}

export type CourseGrammarFailureKind =
	| 'invalid-candidate'
	| 'missing-number-badge'
	| 'missing-tee'
	| 'missing-basket'
	| 'weak-number-confidence'
	| 'weak-tee-confidence'
	| 'weak-basket-confidence'
	| 'ambiguous-tee'
	| 'ambiguous-basket'
	| 'basket-polarity-conflict';

export interface CourseGrammarFailure {
	readonly kind: CourseGrammarFailureKind;
	readonly severity: 'warning' | 'error';
	readonly message: string;
	readonly holeNumber?: number;
	readonly candidateKind?: 'number-badge' | 'tee' | 'basket';
	readonly candidateIndex?: number;
}

export interface NumberBadgeAssignment {
	readonly candidateIndex: number;
	readonly xPx: number;
	readonly yPx: number;
	readonly confidence: number;
	/** Zero is best; this is `1 - glyph confidence`. */
	readonly cost: number;
}

export interface TeeAssignment {
	readonly candidateIndex: number;
	readonly xPx: number;
	readonly yPx: number;
	readonly detectorConfidence: number;
	readonly confidence: number;
	readonly distancePx: number;
	/** Distance to the next-best tee for this badge, when one exists. */
	readonly runnerUpDistancePx?: number;
}

export interface BasketAssignment {
	readonly candidateIndex: number;
	readonly xPx: number;
	readonly yPx: number;
	readonly detectorConfidence: number;
	readonly confidence: number;
	readonly distancePx: number;
	/**
	 * -1 means tee and basket lie on opposite badge rays (ideal); +1 means
	 * same ray (strongly suspicious). Undefined when the hole has no
	 * resolved tee to define a ray from -- distance-only ownership.
	 */
	readonly polarityCosine?: number;
	/** Hungarian cost: distance + opposite-direction penalty. */
	readonly cost: number;
	readonly runnerUpCost?: number;
}

export interface CourseHoleProposal {
	readonly number: number;
	readonly numberBadge?: NumberBadgeAssignment;
	readonly tee?: TeeAssignment;
	readonly basket?: BasketAssignment;
	/** Combined ownership confidence, normalized to 0..1. */
	readonly confidence: number;
	readonly status: 'ready' | 'review' | 'incomplete';
	readonly failures: readonly CourseGrammarFailure[];
}

export interface CourseGrammarResult {
	readonly holes: readonly CourseHoleProposal[];
	readonly failures: readonly CourseGrammarFailure[];
	readonly unassigned: {
		readonly numberBadgeCandidateIndexes: readonly number[];
		readonly teeCandidateIndexes: readonly number[];
		readonly basketCandidateIndexes: readonly number[];
	};
}

interface IndexedPoint {
	/** Position in the array this module was actually given -- used only to index back into that same array (`input.tees[tee.sourceIndex]` etc.), never reported externally. */
	readonly sourceIndex: number;
	/** The index reported in every externally-visible `candidateIndex` field -- the caller's raw detector-array index when supplied, array position otherwise. See `CoursePointCandidate.candidateIndex`. */
	readonly reportedIndex: number;
	readonly xPx: number;
	readonly yPx: number;
	readonly confidence: number;
}

interface IndexedBadge extends IndexedPoint {
	readonly holeNumber?: number;
	readonly labelScores?: readonly NumberBadgeLabelScore[];
}

interface TeeDetails {
	readonly assignment: TeeAssignment;
}

interface BasketDetails {
	readonly assignment: BasketAssignment;
}

const BLOCKED_COST = 1_000_000_000;
const DUMMY_COST = 100_000_000;
const DEFAULT_DETECTOR_CONFIDENCE = 0.75;
const DEFAULT_BASKET_POLARITY_PENALTY_PX = 80;

/**
 * Derives the polarity weight from this course's own native geometry. The
 * median nearest badge-to-basket distance is robust to a few false peaks;
 * doubling it makes a fully same-ray endpoint pay four median distances
 * relative to an opposite-ray endpoint, without encoding capture scale.
 */
export function deriveBasketPolarityPenaltyPx(
	badges: readonly Pick<CourseNumberBadgeCandidate, 'xPx' | 'yPx'>[],
	baskets: readonly Pick<CourseBasketCandidate, 'xPx' | 'yPx'>[]
): number {
	if (badges.length === 0 || baskets.length === 0) return DEFAULT_BASKET_POLARITY_PENALTY_PX;
	const distances = badges
		.map((badge) => Math.min(...baskets.map((basket) => Math.hypot(basket.xPx - badge.xPx, basket.yPx - badge.yPx))))
		.filter((distance) => Number.isFinite(distance) && distance > 0)
		.sort((a, b) => a - b);
	if (distances.length === 0) return DEFAULT_BASKET_POLARITY_PENALTY_PX;
	const middle = Math.floor(distances.length / 2);
	const median = distances.length % 2 === 0 ? (distances[middle - 1] + distances[middle]) / 2 : distances[middle];
	return median * 2;
}

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function medianNumber(values: readonly number[]): number | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function finite(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function candidateConfidence(candidate: CoursePointCandidate): number {
	const supplied = candidate.confidence ?? candidate.score;
	// A few CV probes use non-normalized visual scores.  They remain useful to
	// their detector, but should not turn every proposal into a fake 100% here.
	return finite(supplied) && supplied >= 0 && supplied <= 1
		? clamp01(supplied)
		: DEFAULT_DETECTOR_CONFIDENCE;
}

function pointDistance(a: Pick<IndexedPoint, 'xPx' | 'yPx'>, b: Pick<IndexedPoint, 'xPx' | 'yPx'>): number {
	return Math.hypot(a.xPx - b.xPx, a.yPx - b.yPx);
}

function uniqueHoleNumbers(input: readonly number[] | undefined): number[] {
	const source = input ?? DEFAULT_COURSE_HOLE_NUMBERS;
	const result: number[] = [];
	for (const number of source) {
		if (Number.isInteger(number) && number > 0 && !result.includes(number)) result.push(number);
	}
	return result.sort((a, b) => a - b);
}

function normalizePoints<T extends CoursePointCandidate>(
	candidates: readonly T[],
	kind: 'number-badge' | 'tee' | 'basket',
	failures: CourseGrammarFailure[]
): IndexedPoint[] {
	const points: IndexedPoint[] = [];
	candidates.forEach((candidate, sourceIndex) => {
		// `candidate.candidateIndex`, when supplied, is the caller's own raw
		// detector-array index -- see `CoursePointCandidate.candidateIndex`'s
		// doc comment. Falls back to array position for callers that pass the
		// raw array directly (today's badges/baskets), where the two coincide.
		const reportedIndex = candidate.candidateIndex ?? sourceIndex;
		if (!finite(candidate.xPx) || !finite(candidate.yPx)) {
			failures.push({
				kind: 'invalid-candidate',
				severity: 'warning',
				candidateKind: kind,
				candidateIndex: reportedIndex,
				message: `${kind} candidate ${sourceIndex + 1} has non-finite source-image coordinates.`
			});
			return;
		}
		points.push({
			sourceIndex,
			reportedIndex,
			xPx: candidate.xPx,
			yPx: candidate.yPx,
			confidence: candidateConfidence(candidate)
		});
	});
	return points;
}

function normalizeBadges(
	candidates: readonly CourseNumberBadgeCandidate[],
	failures: CourseGrammarFailure[]
): IndexedBadge[] {
	const points = normalizePoints(candidates, 'number-badge', failures);
	return points.map((point) => {
		const candidate = candidates[point.sourceIndex];
		return {
			...point,
			holeNumber:
				Number.isInteger(candidate.holeNumber) && (candidate.holeNumber as number) > 0
					? candidate.holeNumber
					: undefined,
			labelScores: candidate.labelScores
		};
	});
}

/**
 * Hungarian minimum-cost assignment for a matrix with rows <= columns.  The
 * caller adds dummy columns so a hole is explicitly unassigned rather than
 * accidentally borrowing a candidate twice.
 */
function hungarian(cost: readonly (readonly number[])[]): number[] {
	const rowCount = cost.length;
	if (rowCount === 0) return [];
	const columnCount = cost[0]?.length ?? 0;
	if (columnCount < rowCount) throw new Error('Hungarian assignment requires at least as many columns as rows.');
	if (cost.some((row) => row.length !== columnCount)) throw new Error('Hungarian assignment received a ragged cost matrix.');

	const u = new Array<number>(rowCount + 1).fill(0);
	const v = new Array<number>(columnCount + 1).fill(0);
	const p = new Array<number>(columnCount + 1).fill(0);
	const way = new Array<number>(columnCount + 1).fill(0);

	for (let row = 1; row <= rowCount; row += 1) {
		p[0] = row;
		let column0 = 0;
		const minValue = new Array<number>(columnCount + 1).fill(Number.POSITIVE_INFINITY);
		const used = new Array<boolean>(columnCount + 1).fill(false);
		do {
			used[column0] = true;
			const row0 = p[column0];
			let delta = Number.POSITIVE_INFINITY;
			let column1 = 0;
			for (let column = 1; column <= columnCount; column += 1) {
				if (used[column]) continue;
				const reducedCost = cost[row0 - 1][column - 1] - u[row0] - v[column];
				if (reducedCost < minValue[column]) {
					minValue[column] = reducedCost;
					way[column] = column0;
				}
				if (minValue[column] < delta) {
					delta = minValue[column];
					column1 = column;
				}
			}
			for (let column = 0; column <= columnCount; column += 1) {
				if (used[column]) {
					u[p[column]] += delta;
					v[column] -= delta;
				} else {
					minValue[column] -= delta;
				}
			}
			column0 = column1;
		} while (p[column0] !== 0);

		do {
			const column1 = way[column0];
			p[column0] = p[column1];
			column0 = column1;
		} while (column0 !== 0);
	}

	const assignment = new Array<number>(rowCount).fill(-1);
	for (let column = 1; column <= columnCount; column += 1) {
		if (p[column] !== 0) assignment[p[column] - 1] = column - 1;
	}
	return assignment;
}

function withDummyColumns(cost: readonly (readonly number[])[], candidateCount: number): number[][] {
	const rows = cost.length;
	const columnCount = Math.max(candidateCount, rows);
	return cost.map((row) => [
		...row,
		...new Array<number>(columnCount - candidateCount).fill(DUMMY_COST)
	]);
}

function labelConfidence(badge: IndexedBadge, holeNumber: number): number | undefined {
	const matchingScore = badge.labelScores?.find((score) => score.holeNumber === holeNumber)?.confidence;
	if (finite(matchingScore)) return clamp01(matchingScore);
	return badge.holeNumber === holeNumber ? badge.confidence : undefined;
}

function assignmentMargin(best: number, alternatives: readonly number[]): number | undefined {
	const sorted = [...alternatives].sort((a, b) => a - b);
	const bestIndex = sorted.findIndex((value) => Math.abs(value - best) < 1e-6);
	return bestIndex === -1 ? undefined : sorted[bestIndex + 1];
}

function endpointConfidence(detectorConfidence: number, localRank: number, chosen: number, nearest: number, runnerUp?: number): number {
	const compromise = chosen <= nearest + 1e-6 ? 1 : nearest / Math.max(nearest, chosen);
	const separation = runnerUp === undefined ? 0.8 : clamp01((runnerUp - chosen) / Math.max(1, runnerUp));
	const geometry = (0.62 + separation * 0.38) * compromise;
	return clamp01(detectorConfidence * 0.35 + geometry * 0.65 - Math.max(0, localRank - 1) * 0.08);
}

/**
 * Cosine of the angle at `badge` between rays toward `a` and `b`.  -1 means
 * opposite rays (ideal tee/basket topology), +1 means the same ray (strongly
 * suspicious — the two endpoints are on the same side of the badge).
 */
function raysPolarityCosine(
	badge: Pick<IndexedPoint, 'xPx' | 'yPx'>,
	a: Pick<IndexedPoint, 'xPx' | 'yPx'>,
	b: Pick<IndexedPoint, 'xPx' | 'yPx'>
): number {
	const aX = a.xPx - badge.xPx;
	const aY = a.yPx - badge.yPx;
	const bX = b.xPx - badge.xPx;
	const bY = b.yPx - badge.yPx;
	const aLength = Math.hypot(aX, aY);
	const bLength = Math.hypot(bX, bY);
	return aLength > 1e-6 && bLength > 1e-6
		? Math.max(-1, Math.min(1, (aX * bX + aY * bY) / (aLength * bLength)))
		: 1;
}

function basketCost(
	badge: Pick<IndexedPoint, 'xPx' | 'yPx'>,
	tee: Pick<IndexedPoint, 'xPx' | 'yPx'>,
	basket: Pick<IndexedPoint, 'xPx' | 'yPx'>,
	polarityPenaltyPx: number
): {
	distancePx: number;
	polarityCosine: number;
	cost: number;
} {
	const basketLength = pointDistance(badge, basket);
	const polarityCosine = raysPolarityCosine(badge, tee, basket);
	return {
		distancePx: basketLength,
		polarityCosine,
		cost: basketLength + polarityPenaltyPx * (polarityCosine + 1)
	};
}

function holeConfidence(
	badge: NumberBadgeAssignment | undefined,
	tee: TeeAssignment | undefined,
	basket: BasketAssignment | undefined
): number {
	if (!badge || !tee || !basket) return 0;
	return clamp01(badge.confidence * 0.30 + tee.confidence * 0.30 + basket.confidence * 0.40);
}

function failureFor(
	failures: readonly CourseGrammarFailure[],
	holeNumber: number
): CourseGrammarFailure[] {
	return failures.filter((failure) => failure.holeNumber === holeNumber);
}

/**
 * Associates detected number badges, tee pads, and basket bases into ordered
 * hole proposals.  It never mutates candidates and never silently drops a
 * missing endpoint: each standard-hole proposal is returned with explicit
 * failures for review.
 */
export function associateCourseGrammar(input: CourseGrammarInput): CourseGrammarResult {
	const failures: CourseGrammarFailure[] = [];
	const holeNumbers = uniqueHoleNumbers(input.holeNumbers);
	const badges = normalizeBadges(input.numberBadges, failures);
	const tees = normalizePoints(input.tees, 'tee', failures);
	const baskets = normalizePoints(input.baskets, 'basket', failures);
	const polarityPenaltyPx =
		finite(input.basketPolarityPenaltyPx) && input.basketPolarityPenaltyPx >= 0
			? input.basketPolarityPenaltyPx
			: DEFAULT_BASKET_POLARITY_PENALTY_PX;

	// Stage 1: badge ownership.  The explicit global solve is what avoids two
	// visually similar glyphs both claiming one hole label.
	const badgeCosts = holeNumbers.map((holeNumber) =>
		badges.map((badge) => {
			const confidence = labelConfidence(badge, holeNumber);
			return confidence === undefined ? BLOCKED_COST : 1 - confidence;
		})
	);
	const badgeAssignments = hungarian(withDummyColumns(badgeCosts, badges.length));
	const badgeForHole = new Map<number, NumberBadgeAssignment>();
	holeNumbers.forEach((holeNumber, row) => {
		const badgeIndex = badgeAssignments[row];
		if (badgeIndex < 0 || badgeIndex >= badges.length || badgeCosts[row][badgeIndex] >= BLOCKED_COST) {
			failures.push({
				kind: 'missing-number-badge',
				severity: 'error',
				holeNumber,
				message: `Hole ${holeNumber} has no uniquely assignable number badge.`
			});
			return;
		}
		const badge = badges[badgeIndex];
		const confidence = labelConfidence(badge, holeNumber) ?? 0;
		badgeForHole.set(holeNumber, {
			candidateIndex: badge.reportedIndex,
			xPx: badge.xPx,
			yPx: badge.yPx,
			confidence,
			cost: badgeCosts[row][badgeIndex]
		});
		if (confidence < 0.5) {
			failures.push({
				kind: 'weak-number-confidence',
				severity: 'warning',
				holeNumber,
				candidateKind: 'number-badge',
				candidateIndex: badge.reportedIndex,
				message: `Hole ${holeNumber}'s number badge is only ${(confidence * 100).toFixed(0)}% confident.`
			});
		}
	});

	// Stage 2: a preliminary, tee-independent basket pass.  Baskets are the more
	// reliable detector, so their rough direction from each badge is known
	// before any tee is chosen.  This is used only to orient Stage 3 below; the
	// authoritative basket assignment is recomputed in Stage 4 once a tee (and
	// therefore precise polarity) exists.
	const preliminaryBasketHoleNumbers = holeNumbers.filter((holeNumber) => badgeForHole.has(holeNumber));
	const preliminaryBasketCosts = preliminaryBasketHoleNumbers.map((holeNumber) => {
		const badge = badgeForHole.get(holeNumber)!;
		return baskets.map((basket) => pointDistance(badge, basket));
	});
	const preliminaryBasketAssignments = hungarian(withDummyColumns(preliminaryBasketCosts, baskets.length));
	const preliminaryBasketForHole = new Map<number, IndexedPoint>();
	preliminaryBasketHoleNumbers.forEach((holeNumber, row) => {
		const basketIndex = preliminaryBasketAssignments[row];
		if (basketIndex >= 0 && basketIndex < baskets.length) {
			preliminaryBasketForHole.set(holeNumber, baskets[basketIndex]);
		}
	});

	// Stage 3: tee ownership.  The static parser used raw badge-to-tee distance
	// inside a one-to-one Hungarian assignment.  That grammar alone is locally
	// misleading in dense clusters where a neighboring hole's badge sits closer
	// to this hole's tee than its own badge does (the H5/H6 case: hole 6's
	// badge can be nearer to hole 5's physical tee than hole 5's own badge is).
	// Walking backward from the reliable preliminary basket resolves it: a tee
	// on the opposite side of the badge from its known basket is preferred,
	// using the same opposite-ray polarity concept Stage 4 already applies to
	// baskets.
	const teeHoleNumbers = holeNumbers.filter((holeNumber) => badgeForHole.has(holeNumber));
	const teeCosts = teeHoleNumbers.map((holeNumber) => {
		const badge = badgeForHole.get(holeNumber)!;
		const preliminaryBasket = preliminaryBasketForHole.get(holeNumber);
		return tees.map((tee) => {
			const sourceTee = input.tees[tee.sourceIndex];
			if (sourceTee.holeNumber !== undefined && sourceTee.holeNumber !== holeNumber) return BLOCKED_COST;
			const distance = pointDistance(badge, tee);
			if (!preliminaryBasket) return distance;
			const polarityCosine = raysPolarityCosine(badge, tee, preliminaryBasket);
			return distance + polarityPenaltyPx * (polarityCosine + 1);
		});
	});
	const teeAssignments = hungarian(withDummyColumns(teeCosts, tees.length));
	const teeForHole = new Map<number, TeeDetails>();
	teeHoleNumbers.forEach((holeNumber, row) => {
		const teeIndex = teeAssignments[row];
		if (teeIndex < 0 || teeIndex >= tees.length || teeCosts[row][teeIndex] >= BLOCKED_COST) {
			failures.push({
				kind: 'missing-tee',
				severity: 'error',
				holeNumber,
				message: `Hole ${holeNumber} has no unclaimed tee candidate.`
			});
			return;
		}
		const tee = tees[teeIndex];
		const distances = teeCosts[row];
		const chosen = distances[teeIndex];
		const sorted = [...distances].sort((a, b) => a - b);
		const nearest = sorted[0] ?? chosen;
		const runnerUp = assignmentMargin(chosen, distances);
		const localRank = distances.filter((distance) => distance < chosen - 1e-6).length + 1;
		const sourceTee = input.tees[tee.sourceIndex];
		const rawConfidence = endpointConfidence(tee.confidence, localRank, chosen, nearest, runnerUp);
		const confidence = sourceTee.bootstrapDecision === 'review' ? Math.min(rawConfidence, 0.49) : rawConfidence;
		teeForHole.set(holeNumber, {
			assignment: {
				candidateIndex: tee.reportedIndex,
				xPx: tee.xPx,
				yPx: tee.yPx,
				detectorConfidence: tee.confidence,
				confidence,
				distancePx: chosen,
				...(runnerUp === undefined ? {} : { runnerUpDistancePx: runnerUp })
			}
		});
		if (sourceTee.bootstrapDecision === 'review' || confidence < 0.5) {
			failures.push({
				kind: 'weak-tee-confidence',
				severity: 'warning',
				holeNumber,
				candidateKind: 'tee',
				candidateIndex: tee.reportedIndex,
				message: sourceTee.bootstrapDecision === 'review'
					? `Hole ${holeNumber}'s tee is a bootstrap REVIEW proposal, not an automatic acceptance.`
					: `Hole ${holeNumber}'s tee assignment is weak after global ownership matching.`
			});
		}
		if (localRank > 1) {
			failures.push({
				kind: 'ambiguous-tee',
				severity: 'warning',
				holeNumber,
				candidateKind: 'tee',
				candidateIndex: tee.reportedIndex,
				message: `Hole ${holeNumber} received its ${localRank}th-nearest tee because a nearer tee belongs to another hole.`
			});
		}
	});

	// Stage 4: baskets, final two-tier pass. A badge normally sits between its
	// tee and basket. Independently AUTO-owned tees may reserve from polarity;
	// weaker holes then consume the remaining vocabulary via distance only.
	//
	// Every badge-having hole competes here, even one whose Stage 3 tee
	// bootstrap failed (`missing-tee`): dropping it from the pool would not
	// remove its basket from the world, it would just leave that basket
	// unclaimed and available for a neighboring (tee-having) hole to win by
	// distance/polarity math, even when that neighbor's own badge is farther
	// from it than the tee-less hole's badge is. A tee-less hole falls back
	// to distance-only cost -- `raysPolarityCosine`/`basketCost` need a real
	// tee point to define the ray, and there is no principled substitute for
	// one (in particular, `preliminaryBasketForHole` is a basket, not a
	// tee-like reference, and reusing it here would be circular).
	const basketHoleNumbers = teeHoleNumbers;
	const basketCosts = basketHoleNumbers.map((holeNumber) => {
		const badge = badgeForHole.get(holeNumber)!;
		const tee = teeForHole.get(holeNumber)?.assignment;
		return baskets.map((basket) =>
			tee ? basketCost(badge, tee, basket, polarityPenaltyPx).cost : pointDistance(badge, basket)
		);
	});
	// Basket ownership is intentionally two-stage. Only independently AUTO-
	// owned tees may use tee/basket polarity to reserve a basket. REVIEW tees
	// are useful grading evidence, but allowing one wrong review proposal into
	// a single global solve can permute several otherwise-correct baskets.
	const basketAssignments = new Array<number>(basketHoleNumbers.length).fill(-1);
	const assignmentCosts = basketHoleNumbers.map((holeNumber, row) => {
		const badge = badgeForHole.get(holeNumber)!;
		const sourceTee = input.tees.find(
			(candidate) => candidate.holeNumber === holeNumber && candidate.bootstrapDecision === 'auto'
		);
		return sourceTee ? basketCosts[row] : baskets.map((basket) => pointDistance(badge, basket));
	});
	const autoRows = basketHoleNumbers
		.map((holeNumber, row) => ({ holeNumber, row }))
		.filter(({ holeNumber }) => polarityPenaltyPx > 0 && input.tees.some(
			(candidate) => candidate.holeNumber === holeNumber && candidate.bootstrapDecision === 'auto'
		));
	const claimedBasketIndexes = new Set<number>();
	// Each AUTO tee proposes only its own best polarity-aware basket. Conflicts
	// are resolved by local cost margin (then tee confidence); a loser defers to
	// stage 2 rather than taking a second-best basket and cascading a swap.
	const autoClaims = autoRows.map(({ row }) => {
		const sorted = assignmentCosts[row]
			.map((cost, basketIndex) => ({ cost, basketIndex }))
			.sort((a, b) => a.cost - b.cost || a.basketIndex - b.basketIndex);
		return {
			row,
			basketIndex: sorted[0]?.basketIndex ?? -1,
			margin: (sorted[1]?.cost ?? BLOCKED_COST) - (sorted[0]?.cost ?? BLOCKED_COST),
			confidence: teeForHole.get(basketHoleNumbers[row])?.assignment.detectorConfidence ?? 0
		};
	}).sort((a, b) => b.margin - a.margin || b.confidence - a.confidence || a.row - b.row);
	for (const claim of autoClaims) {
		if (claim.basketIndex < 0 || claimedBasketIndexes.has(claim.basketIndex)) continue;
		basketAssignments[claim.row] = claim.basketIndex;
		claimedBasketIndexes.add(claim.basketIndex);
	}

	const remainingRows = basketHoleNumbers
		.map((holeNumber, row) => ({ holeNumber, row }))
		.filter(({ row }) => basketAssignments[row] < 0);
	const remainingBasketIndexes = baskets
		.map((_, index) => index)
		.filter((index) => !claimedBasketIndexes.has(index));
	if (remainingRows.length > 0 && remainingBasketIndexes.length > 0) {
		const trustedDistanceMedian = medianNumber(
			autoClaims
				.filter((claim) => basketAssignments[claim.row] >= 0)
				.map((claim) => pointDistance(
					badgeForHole.get(basketHoleNumbers[claim.row])!,
					baskets[basketAssignments[claim.row]]
				))
		);
		for (const { row } of remainingRows) {
			const badge = badgeForHole.get(basketHoleNumbers[row])!;
			assignmentCosts[row] = baskets.map((basket) => {
				const distance = pointDistance(badge, basket);
				// Still distance-only: prefer distances plausible for baskets already
				// secured by trusted AUTO topology, without using REVIEW tee direction.
				return trustedDistanceMedian === undefined
					? distance
					: distance + Math.abs(distance - trustedDistanceMedian);
			});
		}
		const remainingCosts = remainingRows.map(({ row }) =>
			remainingBasketIndexes.map((basketIndex) => assignmentCosts[row][basketIndex])
		);
		const remainingAssignment = hungarian(withDummyColumns(remainingCosts, remainingBasketIndexes.length));
		remainingRows.forEach(({ row }, index) => {
			const localBasketIndex = remainingAssignment[index];
			if (localBasketIndex < 0 || localBasketIndex >= remainingBasketIndexes.length) return;
			basketAssignments[row] = remainingBasketIndexes[localBasketIndex];
		});
	}
	const basketForHole = new Map<number, BasketDetails>();
	basketHoleNumbers.forEach((holeNumber, row) => {
		const basketIndex = basketAssignments[row];
		if (basketIndex < 0 || basketIndex >= baskets.length) {
			failures.push({
				kind: 'missing-basket',
				severity: 'error',
				holeNumber,
				message: `Hole ${holeNumber} has no unclaimed basket candidate.`
			});
			return;
		}
		const basket = baskets[basketIndex];
		const badge = badgeForHole.get(holeNumber)!;
		const tee = teeForHole.get(holeNumber)?.assignment;
		const distancePx = pointDistance(badge, basket);
		const detail = tee
			? basketCost(badge, tee, basket, polarityPenaltyPx)
			: { distancePx, polarityCosine: undefined, cost: distancePx };
		const costs = assignmentCosts[row];
		const chosen = costs[basketIndex];
		const sorted = [...costs].sort((a, b) => a - b);
		const nearest = sorted[0] ?? chosen;
		const runnerUp = assignmentMargin(chosen, costs);
		const localRank = costs.filter((cost) => cost < chosen - 1e-6).length + 1;
		const topologyConfidence = endpointConfidence(basket.confidence, localRank, chosen, nearest, runnerUp);
		// No tee means no ray to score polarity against. Rather than fabricate a
		// polarity value that could read as more (or less) confident than the
		// topology alone earns, the blend collapses to topology only.
		const polarityConfidence =
			detail.polarityCosine === undefined ? topologyConfidence : clamp01((1 - detail.polarityCosine) / 2);
		const rawConfidence = clamp01(topologyConfidence * 0.75 + polarityConfidence * 0.25);
		const sourceBasket = input.baskets[basket.sourceIndex];
		const confidence = sourceBasket.bootstrapDecision === 'review' ? Math.min(rawConfidence, 0.49) : rawConfidence;
		basketForHole.set(holeNumber, {
			assignment: {
				candidateIndex: basket.reportedIndex,
				xPx: basket.xPx,
				yPx: basket.yPx,
				detectorConfidence: basket.confidence,
				confidence,
				distancePx: detail.distancePx,
				polarityCosine: detail.polarityCosine,
				cost: detail.cost,
				...(runnerUp === undefined ? {} : { runnerUpCost: runnerUp })
			}
		});
		if (sourceBasket.bootstrapDecision === 'review' || confidence < 0.5) {
			failures.push({
				kind: 'weak-basket-confidence',
				severity: 'warning',
				holeNumber,
				candidateKind: 'basket',
				candidateIndex: basket.reportedIndex,
				message: sourceBasket.bootstrapDecision === 'review'
					? `Hole ${holeNumber}'s basket is an occlusion-fallback REVIEW proposal, not an automatic acceptance.`
					: `Hole ${holeNumber}'s basket assignment is weak after polarity-aware matching.`
			});
		}
		if (localRank > 1) {
			failures.push({
				kind: 'ambiguous-basket',
				severity: 'warning',
				holeNumber,
				candidateKind: 'basket',
				candidateIndex: basket.reportedIndex,
				message: `Hole ${holeNumber} received its ${localRank}th-lowest basket cost because a better basket belongs to another hole.`
			});
		}
		if (detail.polarityCosine !== undefined && detail.polarityCosine > 0.4) {
			failures.push({
				kind: 'basket-polarity-conflict',
				severity: 'warning',
				holeNumber,
				candidateKind: 'basket',
				candidateIndex: basket.reportedIndex,
				message: `Hole ${holeNumber}'s basket lies on the same side of its number badge as its tee.`
			});
		}
	});

	// A missing badge suppresses every subsequent ownership stage (Stage 3 and
	// Stage 4 both key off `badgeForHole`); make each absent endpoint explicit
	// so UI review does not look like a partially successful automatic
	// placement. A missing *tee* no longer implies a missing basket -- Stage 4
	// still runs distance-only basket matching for a tee-less hole and already
	// records its own `missing-basket` failure above if that solve also comes
	// up empty, so there is nothing to synthesize here for that case.
	for (const holeNumber of holeNumbers) {
		if (!badgeForHole.has(holeNumber)) {
			failures.push({
				kind: 'missing-tee',
				severity: 'error',
				holeNumber,
				message: `Hole ${holeNumber}'s tee cannot be associated without its number badge.`
			});
			failures.push({
				kind: 'missing-basket',
				severity: 'error',
				holeNumber,
				message: `Hole ${holeNumber}'s basket cannot be associated without its number badge.`
			});
		}
	}

	const assignedBadgeIndexes = new Set([...badgeForHole.values()].map((assignment) => assignment.candidateIndex));
	const assignedTeeIndexes = new Set([...teeForHole.values()].map(({ assignment }) => assignment.candidateIndex));
	const assignedBasketIndexes = new Set([...basketForHole.values()].map(({ assignment }) => assignment.candidateIndex));
	const holes: CourseHoleProposal[] = holeNumbers.map((number) => {
		const badge = badgeForHole.get(number);
		const tee = teeForHole.get(number)?.assignment;
		const basket = basketForHole.get(number)?.assignment;
		const holeFailures = failureFor(failures, number);
		const confidence = holeConfidence(badge, tee, basket);
		const hasError = holeFailures.some((failure) => failure.severity === 'error');
		return {
			number,
			...(badge ? { numberBadge: badge } : {}),
			...(tee ? { tee } : {}),
			...(basket ? { basket } : {}),
			confidence,
			status: hasError ? 'incomplete' : confidence >= 0.7 && holeFailures.length === 0 ? 'ready' : 'review',
			failures: holeFailures
		};
	});

	return {
		holes,
		failures,
		unassigned: {
			numberBadgeCandidateIndexes: badges
				.map((badge) => badge.reportedIndex)
				.filter((index) => !assignedBadgeIndexes.has(index)),
			teeCandidateIndexes: tees.map((tee) => tee.reportedIndex).filter((index) => !assignedTeeIndexes.has(index)),
			basketCandidateIndexes: baskets
				.map((basket) => basket.reportedIndex)
				.filter((index) => !assignedBasketIndexes.has(index))
		}
	};
}
