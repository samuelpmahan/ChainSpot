// Blind G5 straight-hole resolver.
//
// Upstream G4 has already established Tee→Badge ownership. This producer does
// one deliberately physical thing with that testimony: extend the directed
// Tee→Badge corridor and rank semantic basket TIPs by encounter order. It
// never reads truth, never routes through basket bboxes, and never mutates
// assignment.

import type { BasketEvidence, ThreeFactorMeasurement } from '../types';
import type { EvidenceBoard, FeatureContext } from './types';
import type { TeeBadgeLockEvidence, TeeBadgeLockEvidenceLock } from './g4.teeBadgeLockMath';
import {
	STRAIGHT_TEST_COORDINATE_FRAME,
	type StraightTestBasketHypothesis,
	type StraightTestMeasurements,
	type StraightTestProposal
} from './st.straightTest.contract';

interface RayEndpoints {
	readonly tee: readonly [number, number];
	readonly badge: readonly [number, number];
}

function endpoints(lock: TeeBadgeLockEvidenceLock): RayEndpoints | null {
	const tee = lock.teeBadgePath[0];
	const badge = lock.teeBadgePath[lock.teeBadgePath.length - 1];
	if (!tee || !badge) return null;
	if (![tee[0], tee[1], badge[0], badge[1]].every(Number.isFinite)) return null;
	if (!(Math.hypot(badge[0] - tee[0], badge[1] - tee[1]) > 0)) return null;
	return { tee, badge };
}

export function rankBasketTipsOnStraightRay(
	lock: TeeBadgeLockEvidenceLock,
	baskets: readonly BasketEvidence[],
	corridorWidthPx: number | null
): readonly StraightTestBasketHypothesis[] {
	const e = endpoints(lock);
	if (!e) return [];
	const dx = e.badge[0] - e.tee[0];
	const dy = e.badge[1] - e.tee[1];
	const length = Math.hypot(dx, dy);
	const ux = dx / length;
	const uy = dy / length;
	const half = corridorWidthPx !== null && corridorWidthPx > 0 ? corridorWidthPx / 2 : null;
	const rows = baskets.map((basket) => {
		const vx = basket.tipXPx - e.badge[0];
		const vy = basket.tipYPx - e.badge[1];
		const alongPx = vx * ux + vy * uy;
		const perpendicularPx = Math.abs(ux * vy - uy * vx);
		const forward = alongPx > 0;
		return {
			basketId: basket.detId,
			tipXPx: basket.tipXPx,
			tipYPx: basket.tipYPx,
			alongPx,
			perpendicularPx,
			forward,
			inCorridor: forward && half !== null && perpendicularPx <= half,
			encounterRank: null,
			strongIdentity: basket.confidence === 'high'
		} satisfies StraightTestBasketHypothesis;
	});
	const encounterOrder = rows
		.filter((row) => row.inCorridor)
		.sort(
			(a, b) =>
				a.alongPx - b.alongPx ||
				a.perpendicularPx - b.perpendicularPx ||
				a.basketId.localeCompare(b.basketId)
		);
	const rankById = new Map(encounterOrder.map((row, index) => [row.basketId, index + 1] as const));
	return rows
		.map((row) => ({ ...row, encounterRank: rankById.get(row.basketId) ?? null }))
		.sort(
			(a, b) =>
				Number(!a.inCorridor) - Number(!b.inCorridor) ||
				(a.encounterRank ?? Number.POSITIVE_INFINITY) -
					(b.encounterRank ?? Number.POSITIVE_INFINITY) ||
				a.perpendicularPx - b.perpendicularPx ||
				a.basketId.localeCompare(b.basketId)
		);
}

function oldGeometryMeasurements(
	tee: readonly [number, number],
	badge: readonly [number, number],
	basket: readonly [number, number]
): StraightTestMeasurements {
	const bx = basket[0] - tee[0];
	const by = basket[1] - tee[1];
	const norm = Math.hypot(bx, by);
	if (!(norm > 0)) {
		return {
			f: null,
			dPerpPx: null,
			axialResidualDeg: null,
			directionalResidualDeg: null,
			collinearityResidualDeg: null
		};
	}
	const ux = bx / norm;
	const uy = by / norm;
	const dx = badge[0] - tee[0];
	const dy = badge[1] - tee[1];
	const f = (dx * bx + dy * by) / (norm * norm);
	const dPerpPx = Math.abs(dx * uy - dy * ux);
	const teeBadgeAngle = Math.atan2(dy, dx);
	const teeBasketAngle = Math.atan2(by, bx);
	const delta = Math.atan2(
		Math.sin(teeBadgeAngle - teeBasketAngle),
		Math.cos(teeBadgeAngle - teeBasketAngle)
	);
	const directionalResidualDeg = (Math.abs(delta) * 180) / Math.PI;
	return {
		f,
		dPerpPx,
		axialResidualDeg: null,
		directionalResidualDeg,
		collinearityResidualDeg: directionalResidualDeg
	};
}

function proposalFor(
	lock: TeeBadgeLockEvidenceLock,
	baskets: readonly BasketEvidence[],
	corridorWidthPx: number | null
): StraightTestProposal {
	const e = endpoints(lock);
	const hypotheses = rankBasketTipsOnStraightRay(lock, baskets, corridorWidthPx);
	const corridor = hypotheses.filter((candidate) => candidate.inCorridor);
	const winner = corridor.find((candidate) => candidate.encounterRank === 1);
	const next = corridor.find((candidate) => candidate.encounterRank === 2);
	const half = corridorWidthPx !== null && corridorWidthPx > 0 ? corridorWidthPx / 2 : null;
	const holeLabel = Number.isInteger(lock.hole) ? String(lock.hole) : null;
	const straightRay = {
		corridorWidthPx,
		corridorHalfWidthPx: half,
		selectedAlongPx: winner?.alongPx ?? null,
		selectedPerpendicularPx: winner?.perpendicularPx ?? null,
		corridorCandidateCount: corridor.length,
		nextTipMarginPx: winner && next ? next.alongPx - winner.alongPx : null
	};

	if (!e || !winner) {
		return {
			proposalId: `straight-${lock.badgeId}-${lock.teeId}-UNKNOWN-basket`,
			holeLabel,
			badgeId: lock.badgeId,
			candidateCount: baskets.length,
			teeId: lock.teeId,
			basketId: null,
			endpointProvenance: {
				badge: 'accepted teeBadgeLock path endpoint',
				tee: 'accepted teeBadgeLock path start',
				basket: 'UNKNOWN -- no forward semantic basket TIP inside corridor'
			},
			geometryEndpoints: null,
			coordinateFrame: STRAIGHT_TEST_COORDINATE_FRAME,
			verdict: 'ABSTAIN',
			selected: false,
			runnerUpProposalId: null,
			measurements: {
				f: null,
				dPerpPx: null,
				axialResidualDeg: null,
				directionalResidualDeg: null,
				collinearityResidualDeg: null
			},
			straightRay,
			basketHypotheses: hypotheses,
			gates: {
				identifiedBadge: holeLabel !== null ? 'PASS' : 'UNKNOWN',
				strongBasketIdentity: 'UNKNOWN',
				semanticStrongRingTee: lock.tier === 'visible' ? 'PASS' : 'UNKNOWN',
				teeAxisToBadgeAgreement: 'UNKNOWN',
				badgeLongitudinalFraction: 'UNKNOWN',
				teeBadgeBasketCollinearity: 'FAIL',
				oneToOneUniqueness: 'UNKNOWN'
			},
			reasons: [
				corridorWidthPx === null
					? 'ABSTAIN: corridorWidthPx testimony is UNKNOWN.'
					: `ABSTAIN: no semantic basket TIP lies forward of the badge within ${half?.toFixed(2) ?? 'UNKNOWN'}px of the accepted Tee→Badge ray.`,
				'No basket assignment is mutated.'
			],
			truthTainted: false
		};
	}

	const basket = baskets.find((candidate) => candidate.detId === winner.basketId)!;
	return {
		proposalId: `straight-${lock.badgeId}-${lock.teeId}-${basket.detId}`,
		holeLabel,
		badgeId: lock.badgeId,
		candidateCount: baskets.length,
		teeId: lock.teeId,
		basketId: basket.detId,
		endpointProvenance: {
			badge: 'accepted teeBadgeLock path endpoint',
			tee: 'accepted teeBadgeLock path start',
			basket: `${basket.tier ?? 'basket'}; semantic basket TIP`
		},
		geometryEndpoints: {
			badge: {
				xPx: e.badge[0],
				yPx: e.badge[1],
				provenance: 'accepted teeBadgeLock path endpoint'
			},
			tee: {
				xPx: e.tee[0],
				yPx: e.tee[1],
				provenance: 'accepted teeBadgeLock path start',
				axisAngleRad: null
			},
			basket: {
				xPx: basket.tipXPx,
				yPx: basket.tipYPx,
				provenance: `${basket.tier ?? 'basket'}; semantic basket TIP`
			}
		},
		coordinateFrame: STRAIGHT_TEST_COORDINATE_FRAME,
		verdict: 'PROVISIONAL',
		selected: true,
		runnerUpProposalId: null,
		measurements: oldGeometryMeasurements(e.tee, e.badge, [basket.tipXPx, basket.tipYPx]),
		straightRay,
		basketHypotheses: hypotheses,
		gates: {
			identifiedBadge: holeLabel !== null ? 'PASS' : 'UNKNOWN',
			strongBasketIdentity: winner.strongIdentity ? 'PASS' : 'FAIL',
			semanticStrongRingTee: lock.tier === 'visible' ? 'PASS' : 'UNKNOWN',
			teeAxisToBadgeAgreement: 'UNKNOWN',
			badgeLongitudinalFraction: 'UNKNOWN',
			teeBadgeBasketCollinearity: 'PASS',
			oneToOneUniqueness: 'UNKNOWN'
		},
		reasons: [
			`BLIND straight hypothesis: ${basket.detId}'s semantic TIP is the first forward TIP encountered inside the existing ${corridorWidthPx?.toFixed(2) ?? 'UNKNOWN'}px directed Tee→Badge corridor.`,
			`TIP testimony: along=${winner.alongPx.toFixed(2)}px, perpendicular=${winner.perpendicularPx.toFixed(2)}px, corridorCandidates=${corridor.length}${next ? `, next TIP +${(next.alongPx - winner.alongPx).toFixed(2)}px downrange` : ''}.`,
			'No basket assignment is mutated.'
		],
		truthTainted: false
	};
}

function enforceUniqueBasketTips(
	proposals: readonly StraightTestProposal[]
): StraightTestProposal[] {
	const counts = new Map<string, number>();
	for (const proposal of proposals) {
		if (proposal.selected && proposal.basketId)
			counts.set(proposal.basketId, (counts.get(proposal.basketId) ?? 0) + 1);
	}
	return proposals.map((proposal) => {
		if (!proposal.selected || !proposal.basketId) return proposal;
		if ((counts.get(proposal.basketId) ?? 0) === 1) {
			return {
				...proposal,
				gates: { ...proposal.gates, oneToOneUniqueness: 'PASS' }
			};
		}
		return {
			...proposal,
			selected: false,
			verdict: 'ABSTAIN',
			gates: { ...proposal.gates, oneToOneUniqueness: 'FAIL' },
			reasons: [
				...proposal.reasons,
				`ABSTAIN: basket TIP ${proposal.basketId} is the local first hit for more than one Tee→Badge corridor.`
			]
		};
	});
}

function emitDrawables(
	ctx: FeatureContext,
	proposals: readonly StraightTestProposal[],
	locks: readonly TeeBadgeLockEvidenceLock[]
): void {
	const lockByBadge = new Map(locks.map((lock) => [lock.badgeId, lock]));
	for (const proposal of proposals) {
		const lock = lockByBadge.get(proposal.badgeId);
		const source = lock ? endpoints(lock) : null;
		const e = proposal.geometryEndpoints;
		const ray = proposal.straightRay;
		const hole = Number(proposal.holeLabel);
		if (
			!proposal.selected ||
			!e ||
			!ray ||
			!source ||
			rawHalf(ray.corridorHalfWidthPx) === null
		) {
			ctx.overlay('straightTest', {
				type: 'point',
				xPx: source?.badge[0] ?? 0,
				yPx: source?.badge[1] ?? 0,
				verdict: 'rejected',
				metadata: {
					straightRole: 'straight-abstention',
					badgeId: proposal.badgeId,
					teeId: proposal.teeId ?? 'UNKNOWN'
				},
				ref: `${proposal.proposalId}:abstain`,
				reason: proposal.reasons.join(' ')
			});
			continue;
		}
		const half = rawHalf(ray.corridorHalfWidthPx)!;
		const values: Record<string, number> = {
			corridorCandidateCount: ray.corridorCandidateCount
		};
		if (Number.isFinite(hole)) values.hole = hole;
		if (ray.selectedAlongPx !== null) values.alongPx = ray.selectedAlongPx;
		if (ray.selectedPerpendicularPx !== null)
			values.perpendicularPx = ray.selectedPerpendicularPx;
		if (ray.corridorWidthPx !== null) values.corridorWidthPx = ray.corridorWidthPx;
		if (ray.nextTipMarginPx !== null) values.nextTipMarginPx = ray.nextTipMarginPx;
		const metadata = {
			straightRole: 'straight-route',
			teeId: proposal.teeId ?? 'UNKNOWN',
			badgeId: proposal.badgeId,
			basketId: proposal.basketId ?? 'UNKNOWN'
		};
		ctx.overlay('straightTest', {
			type: 'polyline',
			path: [
				[e.tee.xPx, e.tee.yPx],
				[e.badge.xPx, e.badge.yPx],
				[e.basket.xPx, e.basket.yPx]
			],
			verdict: 'accepted',
			metadata,
			values,
			ref: `${proposal.proposalId}:route`,
			reason: proposal.reasons[0]
		});
		const dx = e.badge.xPx - e.tee.xPx;
		const dy = e.badge.yPx - e.tee.yPx;
		const length = Math.hypot(dx, dy);
		const nx = (-dy / length) * half;
		const ny = (dx / length) * half;
		for (const sign of [-1, 1]) {
			ctx.overlay('straightTest', {
				type: 'polyline',
				path: [
					[e.tee.xPx + sign * nx, e.tee.yPx + sign * ny],
					[e.basket.xPx + sign * nx, e.basket.yPx + sign * ny]
				],
				verdict: 'info',
				metadata: { ...metadata, straightRole: 'corridor-edge' },
				values,
				ref: `${proposal.proposalId}:corridor-${sign < 0 ? 'left' : 'right'}`
			});
		}
		ctx.overlay('straightTest', {
			type: 'point',
			xPx: e.basket.xPx,
			yPx: e.basket.yPx,
			verdict: 'accepted',
			metadata: { ...metadata, straightRole: 'winning-basket-tip' },
			values,
			ref: `${proposal.proposalId}:winning-tip`,
			reason: 'first semantic basket TIP encountered in directed corridor'
		});
		const winnerAlong = ray.selectedAlongPx ?? 0;
		for (const alternative of proposal.basketHypotheses ?? []) {
			if (
				!alternative.inCorridor ||
				alternative.encounterRank === null ||
				alternative.encounterRank <= 1
			)
				continue;
			ctx.overlay('straightTest', {
				type: 'point',
				xPx: alternative.tipXPx,
				yPx: alternative.tipYPx,
				verdict: 'rejected',
				metadata: {
					straightRole: 'later-basket-tip',
					teeId: proposal.teeId ?? 'UNKNOWN',
					badgeId: proposal.badgeId,
					basketId: alternative.basketId
				},
				values: {
					...(Number.isFinite(hole) ? { hole } : {}),
					alongPx: alternative.alongPx,
					perpendicularPx: alternative.perpendicularPx,
					afterFirstPx: alternative.alongPx - winnerAlong,
					encounterRank: alternative.encounterRank
				},
				ref: `${proposal.proposalId}:later-tip:${alternative.basketId}`,
				reason: `later basket TIP in same corridor: +${(
					alternative.alongPx - winnerAlong
				).toFixed(2)}px after first hit`
			});
		}
	}
}

function rawHalf(value: number | null): number | null {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export function runDirectedStraightTest(
	board: EvidenceBoard,
	ctx: FeatureContext,
	baskets: readonly BasketEvidence[]
): StraightTestProposal[] {
	const teeBadge = board.get<TeeBadgeLockEvidence>('teeBadgeLock');
	const measurement = board.get<ThreeFactorMeasurement>('measurement');
	const width =
		typeof teeBadge.corridorWidthPx === 'number' && Number.isFinite(teeBadge.corridorWidthPx)
			? teeBadge.corridorWidthPx
			: typeof measurement.parameters?.corridorWidthPx === 'number' &&
				  Number.isFinite(measurement.parameters.corridorWidthPx)
				? measurement.parameters.corridorWidthPx
				: null;
	const proposals = enforceUniqueBasketTips(
		teeBadge.locks.map((lock) => proposalFor(lock, baskets, width))
	);
	emitDrawables(ctx, proposals, teeBadge.locks);
	return proposals;
}
