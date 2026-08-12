/**
 * Bend-toward-next-tee basket polarity -- a deferred extension to
 * courseGrammar.ts's opposite-ray polarity penalty, NOT wired into the live
 * pipeline. See docs/deferred-detection-experiments.md for the full status,
 * what was tried, and what would need to be true before this gets wired in.
 *
 * The idea: courseGrammar.ts's `raysPolarityCosine`/`basketCost` assume a
 * badge sits on the straight tee->basket line (cosine near -1). That's right
 * for a straight hole but wrong for a dogleg, where the fairway bends past
 * the badge -- and empirically (checked against two ground-truth fixtures,
 * IMG_5641 and Alex Clark, 5 of 6 bent holes across both) the bend direction
 * tends to match the direction of hole (N+1)'s tee, since course routing
 * typically walks from one green toward the next tee.
 *
 * This module computes the *would-be* discounted polarity penalty for a
 * candidate basket, gated the same way it was validated:
 *  - only when hole (N+1)'s tee is itself a confident (non-bootstrap)
 *    assignment -- corroborating one uncertain candidate with another is the
 *    failure mode this guards against;
 *  - only when no basket among the badge's nearest few candidates already
 *    fits the plain straight model well. Without this gate, an earlier
 *    version of this logic regressed two clearly-straight holes on IMG_5641
 *    (their true, already-well-fitting basket lost a Hungarian-assignment
 *    tie-break to a wrong candidate that happened to fall on the next tee's
 *    side) -- see git history on this branch for the exact before/after.
 *
 * Why it's deferred rather than wired in: on both fixtures with ground
 * truth, every bent hole was already correctly assigned without this
 * discount, so it has never had a real case to fix. It's real, tested,
 * validated-safe code -- just without a demonstrated benefit yet.
 */

export interface BendPolarityPoint {
	readonly xPx: number;
	readonly yPx: number;
}

/** Cosine of the angle at `badge` between rays toward `a` and `b`. -1 = opposite (straight), +1 = same ray. */
export function raysPolarityCosine(badge: BendPolarityPoint, a: BendPolarityPoint, b: BendPolarityPoint): number {
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

/** Signed area (twice) of badge, ref, p -- sign tells which side of the badge->ref line p falls on. */
export function sideOfLine(badge: BendPolarityPoint, ref: BendPolarityPoint, p: BendPolarityPoint): number {
	const refX = ref.xPx - badge.xPx;
	const refY = ref.yPx - badge.yPx;
	const pX = p.xPx - badge.xPx;
	const pY = p.yPx - badge.yPx;
	return refX * pY - refY * pX;
}

/** A bend that happens to land on the right side is still weaker evidence than a clean straight-line topology. */
export const BEND_TOWARD_NEXT_TEE_DISCOUNT = 0.2;
/** A candidate at or below this polarity cosine already fits the plain straight model well enough to decide it. */
export const STRAIGHT_FIT_EXISTS_COSINE = -0.85;

/**
 * Whether `nextTee` should be allowed to inform this badge's basket
 * scoring at all: only when no basket among `nearbyBaskets` (caller should
 * pass the handful nearest to `badge`, e.g. 5) already fits the plain
 * straight model well.
 */
export function isBendDiscountEligible(
	badge: BendPolarityPoint,
	tee: BendPolarityPoint,
	nearbyBaskets: readonly BendPolarityPoint[]
): boolean {
	if (nearbyBaskets.length === 0) return true;
	const bestNearbyPolarityCosine = Math.min(
		...nearbyBaskets.map((basket) => raysPolarityCosine(badge, tee, basket))
	);
	return bestNearbyPolarityCosine > STRAIGHT_FIT_EXISTS_COSINE;
}

/**
 * The effective polarity penalty for `basket`, discounted when its
 * deviation from straight falls on the same side as `nextTee`. Pass
 * `nextTee` as `undefined` (e.g. because `isBendDiscountEligible` returned
 * false, or hole N+1's tee isn't confidently known) to get the plain,
 * undiscounted penalty back unchanged.
 */
export function bendAwarePolarityPenaltyPx(
	badge: BendPolarityPoint,
	tee: BendPolarityPoint,
	basket: BendPolarityPoint,
	polarityPenaltyPx: number,
	nextTee?: BendPolarityPoint
): number {
	if (!nextTee) return polarityPenaltyPx;
	const basketSide = sideOfLine(badge, tee, basket);
	const nextTeeSide = sideOfLine(badge, tee, nextTee);
	if (basketSide === 0 || nextTeeSide === 0 || Math.sign(basketSide) !== Math.sign(nextTeeSide)) {
		return polarityPenaltyPx;
	}
	return polarityPenaltyPx * BEND_TOWARD_NEXT_TEE_DISCOUNT;
}
