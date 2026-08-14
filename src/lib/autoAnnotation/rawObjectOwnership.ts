/**
 * Pancake 3: geometry-only ownership over Pancake-1 objects and Pancake-2
 * labeled badges.
 *
 * Rules:
 * 1. A tee owns a badge only when the tee's UNDIRECTED principal axis passes
 *    through that badge's expanded rectangle.
 * 2. Once tee -> badge direction is known, continue THAT SAME RAY beyond the
 *    badge. A unique basket glyph intersected by the ray is a straight-hole
 *    basket hit.
 * 3. Zero hits stay unresolved. Multiple hits stay conflicts. There is no
 *    nearest-neighbor fallback and no global assignment.
 */

import type { RawMaskBasket, RawMaskTee } from './rawObjectMask';

export interface P2LabeledBadge {
	readonly holeNumber: number;
	readonly glyphScore: number;
	readonly xPx: number;
	readonly yPx: number;
	readonly widthPx: number;
	readonly heightPx: number;
}

export interface P3TeeBadgeHit {
	readonly holeNumber: number;
	readonly teeIndex: number;
	readonly badgeAxisErrorPx: number;
	readonly teeToBadgeProjectionPx: number;
}

export interface P3CandidateBadgeEvidence {
	readonly holeNumber: number;
	readonly badgeAxisErrorPx: number;
}

export interface P3StraightBasketHit extends P3TeeBadgeHit {
	readonly basketIndex: number;
	readonly basketAxisErrorPx: number;
	readonly badgeToBasketProjectionPx: number;
}

export type P3BadgeRayDirection = 'forward' | 'reverse';

export type P3TeeBadgeStatus =
	| 'owned'
	| 'noBadgeHit'
	| 'bidirectionalBadgeConflict'
	| 'sameDirectionTie';

export type P3StraightBasketStatus = 'hit' | 'noDownstreamBasket' | 'conflict' | 'notEvaluated';

export interface P3TeeDiagnostic {
	readonly teeIndex: number;
	readonly holeNumber?: number;
	readonly candidateHoleNumbers: readonly number[];
	readonly candidateBadgeEvidence: readonly P3CandidateBadgeEvidence[];
	readonly teeBadgeStatus: P3TeeBadgeStatus;
	readonly badgeRayDirection?: P3BadgeRayDirection;
	readonly badgeAlongPx?: number;
	readonly badgeAxisErrorPx?: number;
	readonly straightBasketStatus: P3StraightBasketStatus;
	readonly basketIndex?: number;
	readonly basketAlongAfterBadgePx?: number;
	readonly basketAxisErrorPx?: number;
}

export interface P3OwnershipResult {
	readonly teeBadgeHits: readonly P3TeeBadgeHit[];
	readonly straightBasketHits: readonly P3StraightBasketHit[];
	readonly unresolvedTeeIndexes: readonly number[];
	readonly teeConflictIndexes: readonly number[];
	readonly straightBasketConflictHoleNumbers: readonly number[];
	readonly teeDiagnostics: readonly P3TeeDiagnostic[];
}

const BADGE_AXIS_MARGIN_FRACTION = 0.18;
const BASKET_AXIS_MARGIN_FRACTION = 0.22;
const FORWARD_EPSILON_PX = 1;

function axisUnit(orientationDeg: number): { ux: number; uy: number } {
	const radians = (orientationDeg * Math.PI) / 180;
	return { ux: Math.cos(radians), uy: Math.sin(radians) };
}

function project(
	originX: number,
	originY: number,
	ux: number,
	uy: number,
	x: number,
	y: number
): { along: number; across: number } {
	const dx = x - originX;
	const dy = y - originY;
	return {
		along: dx * ux + dy * uy,
		across: Math.abs(dx * -uy + dy * ux)
	};
}

/**
 * Exact-ish line-vs-expanded-rectangle test expressed in the rectangle center's
 * normal distance to the axis. For an axis direction u, the rectangle support
 * radius along the normal n=(-uy,ux) is |n.x|*halfW + |n.y|*halfH.
 */
function axisHitsRect(
	originX: number,
	originY: number,
	ux: number,
	uy: number,
	rect: { xPx: number; yPx: number; widthPx: number; heightPx: number },
	marginFraction: number
): { along: number; across: number } | null {
	const projection = project(originX, originY, ux, uy, rect.xPx, rect.yPx);
	const halfW = rect.widthPx * (0.5 + marginFraction);
	const halfH = rect.heightPx * (0.5 + marginFraction);
	const normalSupport = Math.abs(uy) * halfW + Math.abs(ux) * halfH;
	return projection.across <= normalSupport ? projection : null;
}

interface RayRectHit<T> {
	readonly item: T;
	readonly projection: { along: number; across: number };
	readonly alongPx: number;
}

type FirstRayIntersection<T> =
	| { readonly kind: 'none' }
	| { readonly kind: 'hit'; readonly hit: RayRectHit<T> }
	| { readonly kind: 'tie'; readonly hits: readonly RayRectHit<T>[] };

function firstRayRectIntersection<T>(
	originX: number,
	originY: number,
	ux: number,
	uy: number,
	items: readonly T[],
	rectFor: (item: T) => { xPx: number; yPx: number; widthPx: number; heightPx: number },
	marginFraction: number,
	minimumAlongPx: number
): FirstRayIntersection<T> {
	const intersections: RayRectHit<T>[] = [];
	for (const item of items) {
		const projection = axisHitsRect(
			originX,
			originY,
			ux,
			uy,
			rectFor(item),
			marginFraction
		);
		if (!projection || projection.along <= minimumAlongPx + FORWARD_EPSILON_PX) continue;
		intersections.push({ item, projection, alongPx: projection.along });
	}

	intersections.sort((a, b) => a.alongPx - b.alongPx);
	const first = intersections[0];
	if (!first) return { kind: 'none' };
	const tied = intersections.filter(
		(intersection) => intersection.alongPx - first.alongPx <= FORWARD_EPSILON_PX
	);
	return tied.length > 1 ? { kind: 'tie', hits: tied } : { kind: 'hit', hit: first };
}

function firstBadgeOnRay(
	tee: RawMaskTee,
	ux: number,
	uy: number,
	badges: readonly P2LabeledBadge[],
	directionSign: 1 | -1
): FirstRayIntersection<P2LabeledBadge> {
	return firstRayRectIntersection(
		tee.xPx,
		tee.yPx,
		ux * directionSign,
		uy * directionSign,
		badges,
		(badge) => badge,
		BADGE_AXIS_MARGIN_FRACTION,
		0
	);
}

function firstBasketOnRay(
	tee: RawMaskTee,
	rayUx: number,
	rayUy: number,
	baskets: readonly RawMaskBasket[],
	badgeAlongPx: number
): FirstRayIntersection<RawMaskBasket> {
	return firstRayRectIntersection(
		tee.xPx,
		tee.yPx,
		rayUx,
		rayUy,
		baskets,
		(basket) => ({
			xPx: basket.centerXPx,
			yPx: basket.centerYPx,
			widthPx: basket.widthPx,
			heightPx: basket.heightPx
		}),
		BASKET_AXIS_MARGIN_FRACTION,
		badgeAlongPx
	);
}

function candidateHoleNumbers<T extends { holeNumber: number }>(result: FirstRayIntersection<T>): number[] {
	if (result.kind === 'none') return [];
	if (result.kind === 'hit') return [result.hit.item.holeNumber];
	return result.hits.map((hit) => hit.item.holeNumber);
}

function candidateBadgeEvidence(
	forward: FirstRayIntersection<P2LabeledBadge>,
	reverse: FirstRayIntersection<P2LabeledBadge>
): P3CandidateBadgeEvidence[] {
	const evidenceByHole = new Map<number, P3CandidateBadgeEvidence>();
	for (const result of [forward, reverse]) {
		const hits = result.kind === 'none' ? [] : result.kind === 'hit' ? [result.hit] : result.hits;
		for (const hit of hits) {
			if (!evidenceByHole.has(hit.item.holeNumber)) {
				evidenceByHole.set(hit.item.holeNumber, {
					holeNumber: hit.item.holeNumber,
					badgeAxisErrorPx: hit.projection.across
				});
			}
		}
	}
	return Array.from(evidenceByHole.values());
}

export function deriveP3Ownership(
	tees: readonly RawMaskTee[],
	badges: readonly P2LabeledBadge[],
	baskets: readonly RawMaskBasket[]
): P3OwnershipResult {
	const teeBadgeHits: P3TeeBadgeHit[] = [];
	const straightBasketHits: P3StraightBasketHit[] = [];
	const unresolvedTeeIndexes: number[] = [];
	const teeConflictIndexes: number[] = [];
	const straightBasketConflictHoleNumbers: number[] = [];
	const teeDiagnostics: P3TeeDiagnostic[] = [];

	for (let teeIndex = 0; teeIndex < tees.length; teeIndex += 1) {
		const tee = tees[teeIndex];
		const { ux, uy } = axisUnit(tee.orientationDeg);
		const forward = firstBadgeOnRay(tee, ux, uy, badges, 1);
		const reverse = firstBadgeOnRay(tee, ux, uy, badges, -1);
		const candidateEvidence = candidateBadgeEvidence(forward, reverse);
		const candidateNumbers = Array.from(
			new Set([...candidateHoleNumbers(forward), ...candidateHoleNumbers(reverse)])
		);

		if (forward.kind === 'tie' || reverse.kind === 'tie') {
			teeConflictIndexes.push(teeIndex);
			teeDiagnostics.push({
				teeIndex,
				candidateHoleNumbers: candidateNumbers,
				candidateBadgeEvidence: candidateEvidence,
				teeBadgeStatus: 'sameDirectionTie',
				straightBasketStatus: 'notEvaluated'
			});
			continue;
		}

		const directionalHits: Array<{
			direction: P3BadgeRayDirection;
			hit: RayRectHit<P2LabeledBadge>;
		}> = [];
		if (forward.kind === 'hit') directionalHits.push({ direction: 'forward', hit: forward.hit });
		if (reverse.kind === 'hit') directionalHits.push({ direction: 'reverse', hit: reverse.hit });

		if (directionalHits.length === 0) {
			unresolvedTeeIndexes.push(teeIndex);
			teeDiagnostics.push({
				teeIndex,
				candidateHoleNumbers: [],
				candidateBadgeEvidence: [],
				teeBadgeStatus: 'noBadgeHit',
				straightBasketStatus: 'notEvaluated'
			});
			continue;
		}
		if (directionalHits.length > 1) {
			teeConflictIndexes.push(teeIndex);
			teeDiagnostics.push({
				teeIndex,
				candidateHoleNumbers: candidateNumbers,
				candidateBadgeEvidence: candidateEvidence,
				teeBadgeStatus: 'bidirectionalBadgeConflict',
				straightBasketStatus: 'notEvaluated'
			});
			continue;
		}

		const { direction, hit: badgeHit } = directionalHits[0];
		const badge = badgeHit.item;
		const raySign = direction === 'forward' ? 1 : -1;
		const rayUx = ux * raySign;
		const rayUy = uy * raySign;
		const teeToBadgeProjectionPx = badgeHit.alongPx;
		const teeBadge: P3TeeBadgeHit = {
			holeNumber: badge.holeNumber,
			teeIndex,
			badgeAxisErrorPx: badgeHit.projection.across,
			teeToBadgeProjectionPx
		};
		teeBadgeHits.push(teeBadge);

		const basketResult = firstBasketOnRay(tee, rayUx, rayUy, baskets, teeToBadgeProjectionPx);
		let straightBasketStatus: P3StraightBasketStatus = 'noDownstreamBasket';
		let basketIndex: number | undefined;
		let basketAlongAfterBadgePx: number | undefined;
		let basketAxisErrorPx: number | undefined;
		if (basketResult.kind === 'hit') {
			const basketHit = basketResult.hit;
			straightBasketHits.push({
				...teeBadge,
				basketIndex: baskets.indexOf(basketHit.item),
				basketAxisErrorPx: basketHit.projection.across,
				badgeToBasketProjectionPx: basketHit.alongPx - teeToBadgeProjectionPx
			});
			straightBasketStatus = 'hit';
			basketIndex = baskets.indexOf(basketHit.item);
			basketAlongAfterBadgePx = basketHit.alongPx - teeToBadgeProjectionPx;
			basketAxisErrorPx = basketHit.projection.across;
		} else if (basketResult.kind === 'tie') {
			straightBasketStatus = 'conflict';
			straightBasketConflictHoleNumbers.push(badge.holeNumber);
		}

		teeDiagnostics.push({
			teeIndex,
			holeNumber: badge.holeNumber,
			candidateHoleNumbers: [badge.holeNumber],
			candidateBadgeEvidence: candidateEvidence,
			teeBadgeStatus: 'owned',
			badgeRayDirection: direction,
			badgeAlongPx: teeToBadgeProjectionPx,
			badgeAxisErrorPx: badgeHit.projection.across,
			straightBasketStatus,
			basketIndex,
			basketAlongAfterBadgePx,
			basketAxisErrorPx
		});
	}

	return {
		teeBadgeHits,
		straightBasketHits,
		unresolvedTeeIndexes,
		teeConflictIndexes,
		straightBasketConflictHoleNumbers,
		teeDiagnostics
	};
}
