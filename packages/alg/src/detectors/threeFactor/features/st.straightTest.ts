import type { BadgeEvidence, BasketEvidence, TeeEvidence } from '../types';
import type { ABFeature, EngineUnit } from './types';
import {
	STRAIGHT_TEST_COORDINATE_FRAME,
	type StraightTestCandidateInput,
	type StraightTestGeometryEndpoints,
	type StraightTestMeasurements,
	type StraightTestProposal,
	type StraightTestTruthAssistance,
	type StraightTestTrace
} from './st.straightTest.contract';

const radToDeg = 180 / Math.PI;
const mod = (x: number, period: number) => ((x % period) + period) % period;
const axialResidual = (a: number, b: number) => {
	const d = mod(a - b, Math.PI);
	return Math.min(d, Math.PI - d) * radToDeg;
};
const directionalResidual = (a: number, b: number) => {
	const d = mod(a - b, Math.PI * 2);
	return Math.min(d, Math.PI * 2 - d) * radToDeg;
};

export const straightTestFeature = {
	id: 'straightTest',
	gate: 'G5',
	kind: 'deviation',
	defaultEnabled: false,
	resolveOnlyWhenConfigured: true,
	note: 'Early geometry-only S0 straight-test testimony; never asserts ownership or bend truth.',
	knobs: {
		truthAssisted: {
			default: false,
			note: 'Use verified canonical endpoint coordinates for explicitly tainted comparison only.',
			validate: (value: unknown) =>
				typeof value === 'boolean' ? null : 'truthAssisted must be a boolean'
		}
	}
} satisfies ABFeature;

function vectors(candidate: StraightTestCandidateInput) {
	if (!candidate.tee || !candidate.basket) return null;
	const tx = candidate.tee.xPx,
		ty = candidate.tee.yPx;
	if (
		![
			tx,
			ty,
			candidate.badge.xPx,
			candidate.badge.yPx,
			candidate.basket.xPx,
			candidate.basket.yPx
		].every(Number.isFinite)
	)
		return null;
	const bx = candidate.basket.xPx - tx,
		by = candidate.basket.yPx - ty;
	const norm = Math.hypot(bx, by);
	if (!(norm > 0) || !Number.isFinite(norm)) return null;
	const ux = bx / norm,
		uy = by / norm;
	const dx = candidate.badge.xPx - tx,
		dy = candidate.badge.yPx - ty;
	return {
		norm,
		ux,
		uy,
		dx,
		dy,
		badgeCoincident: dx === 0 && dy === 0,
		basketAngle: Math.atan2(by, bx),
		badgeAngle: Math.atan2(dy, dx)
	};
}

export function measureStraightGeometry(
	candidate: StraightTestCandidateInput
): StraightTestMeasurements {
	const v = vectors(candidate);
	if (!v)
		return {
			f: null,
			dPerpPx: null,
			axialResidualDeg: null,
			directionalResidualDeg: null,
			collinearityResidualDeg: null
		};
	const tee = candidate.tee!;
	const basket = candidate.basket!;
	const f = (v.dx * (basket.xPx - tee.xPx) + v.dy * (basket.yPx - tee.yPx)) / (v.norm * v.norm);
	const dPerpPx = Math.abs(v.dx * v.uy - v.dy * v.ux);
	const axialResidualDeg =
		v.badgeCoincident || tee.angleRad === null || !Number.isFinite(tee.angleRad)
			? null
			: axialResidual(v.badgeAngle, tee.angleRad);
	const directionalResidualDeg = v.badgeCoincident
		? null
		: directionalResidual(v.badgeAngle, v.basketAngle);
	return {
		f,
		dPerpPx,
		axialResidualDeg,
		directionalResidualDeg,
		collinearityResidualDeg: directionalResidualDeg
	};
}

function geometryEndpoints(
	candidate: StraightTestCandidateInput
): StraightTestGeometryEndpoints | null {
	if (!candidate.tee || !candidate.basket) return null;
	if (
		![
			candidate.badge.xPx,
			candidate.badge.yPx,
			candidate.tee.xPx,
			candidate.tee.yPx,
			candidate.basket.xPx,
			candidate.basket.yPx
		].every(Number.isFinite)
	)
		return null;
	return {
		badge: {
			xPx: candidate.badge.xPx,
			yPx: candidate.badge.yPx,
			provenance: candidate.badge.provenance
		},
		tee: {
			xPx: candidate.tee.xPx,
			yPx: candidate.tee.yPx,
			provenance: candidate.tee.provenance,
			axisAngleRad: Number.isFinite(candidate.tee.angleRad) ? candidate.tee.angleRad : null
		},
		basket: {
			xPx: candidate.basket.xPx,
			yPx: candidate.basket.yPx,
			provenance: candidate.basket.provenance
		}
	};
}

export function evaluateStraightTestCandidate(
	candidate: StraightTestCandidateInput,
	assistance: StraightTestTruthAssistance,
	candidateCount = 1
): StraightTestProposal {
	let measuredCandidate = candidate;
	let tainted = false;
	const lock =
		assistance.mode === 'verified-canonical'
			? assistance.locks.find((l) => l.badgeId === candidate.badge.detId)
			: undefined;
	if (assistance.mode === 'verified-canonical') {
		if (!assistance.taint || !lock)
			throw new Error(
				'straightTest truth-assisted run requires verified canonical lock and TRUTH-TAINT'
			);
		measuredCandidate = {
			...candidate,
			tee: {
				detId:
					lock.teeReference === 'canonical-annotation'
						? lock.teeId
						: (candidate.tee?.detId ?? lock.teeId),
				xPx: lock.canonicalTee.xPx,
				yPx: lock.canonicalTee.yPx,
				tier:
					lock.teeReference === 'canonical-annotation'
						? 'canonical'
						: (candidate.tee?.tier ?? 'canonical'),
				angleRad: candidate.tee?.angleRad ?? null,
				provenance: lock.canonicalTee.provenance
			},
			basket: {
				detId: candidate.basket?.detId ?? lock.basketId,
				xPx: lock.canonicalBasket.xPx,
				yPx: lock.canonicalBasket.yPx,
				strongIdentity: candidate.basket?.strongIdentity ?? true,
				provenance: lock.canonicalBasket.provenance
			}
		};
		tainted = true;
	}
	const measurements = measureStraightGeometry(measuredCandidate);
	const gates = {
		identifiedBadge: candidate.badge.label !== null ? 'PASS' : 'FAIL',
		strongBasketIdentity: candidate.basket
			? candidate.basket.strongIdentity
				? 'PASS'
				: 'FAIL'
			: 'UNKNOWN',
		semanticStrongRingTee: candidate.tee
			? candidate.tee.tier === 'ring'
				? 'PASS'
				: 'FAIL'
			: 'UNKNOWN',
		teeAxisToBadgeAgreement: 'UNKNOWN',
		badgeLongitudinalFraction: 'UNKNOWN',
		teeBadgeBasketCollinearity: 'UNKNOWN',
		oneToOneUniqueness: tainted ? 'PASS' : 'UNKNOWN'
	} as const;
	const reasons = tainted
		? [
				'TRUTH-TAINT: verified canonical endpoint lock used for S0 geometry only.',
				'Provisional geometry makes no ownership or bend assertion.'
			]
		: [
				'Soft scoring factors (sigma) are not hard gates; geometry remains UNKNOWN without verified truth.',
				'ABSTAIN: no ownership or bend assertion.',
				'runnerUp UNKNOWN: S0 has no uniqueness/ranking gate.',
				'tee axis UNKNOWN when detector angle evidence is absent.'
			];
	return {
		proposalId: `straight-${candidate.badge.detId}-${measuredCandidate.tee?.detId ?? 'unknown-tee'}-${measuredCandidate.basket?.detId ?? 'unknown-basket'}`,
		holeLabel: candidate.holeLabel,
		badgeId: candidate.badge.detId,
		candidateCount,
		teeId: measuredCandidate.tee?.detId ?? null,
		basketId: measuredCandidate.basket?.detId ?? null,
		endpointProvenance: {
			badge: candidate.badge.provenance,
			tee: measuredCandidate.tee?.provenance ?? 'UNKNOWN',
			basket: measuredCandidate.basket?.provenance ?? 'UNKNOWN'
		},
		geometryEndpoints: geometryEndpoints(measuredCandidate),
		coordinateFrame: STRAIGHT_TEST_COORDINATE_FRAME,
		verdict: tainted ? 'PROVISIONAL' : 'ABSTAIN',
		selected: tainted,
		runnerUpProposalId: null,
		measurements,
		gates,
		reasons,
		truthTainted: tainted
	};
}

function candidateFromEvidence(
	badge: BadgeEvidence,
	tee: TeeEvidence | undefined,
	basket: BasketEvidence | undefined
): StraightTestCandidateInput {
	if (!tee || !basket)
		return {
			holeLabel: badge.label,
			badge: {
				detId: badge.detId,
				xPx: badge.cxPx,
				yPx: badge.cyPx,
				label: badge.label,
				provenance: 'identified badge'
			},
			tee: tee
				? {
						detId: tee.detId,
						xPx: tee.xPx,
						yPx: tee.yPx,
						tier: tee.tier,
						angleRad: tee.angleRad,
						provenance: `${tee.tier}; detector tee`
					}
				: null,
			basket: basket
				? {
						detId: basket.detId,
						xPx: basket.tipXPx,
						yPx: basket.tipYPx,
						strongIdentity: basket.confidence === 'high',
						provenance: `${basket.tier ?? 'basket'}; detector basket`
					}
				: null
		};
	return {
		holeLabel: badge.label,
		badge: {
			detId: badge.detId,
			xPx: badge.cxPx,
			yPx: badge.cyPx,
			label: badge.label,
			provenance: 'identified badge'
		},
		tee: {
			detId: tee.detId,
			xPx: tee.xPx,
			yPx: tee.yPx,
			tier: tee.tier,
			angleRad: tee.angleRad,
			provenance: `${tee.tier}; detector tee`
		},
		basket: {
			detId: basket.detId,
			xPx: basket.tipXPx,
			yPx: basket.tipYPx,
			strongIdentity: basket.confidence === 'high',
			provenance: `${basket.tier ?? 'basket'}; detector basket`
		}
	};
}

export const straightTestUnit: EngineUnit = {
	id: 'straightTest',
	gate: 'G5',
	consumes: ['badges', 'baskets', 'tees', 'straightTestTruthAssistance'],
	produces: ['straightProposals'],
	note: 'Geometry-only early S0; no assignment or bend refinement.',
	run(board, ctx) {
		if (!ctx.resolve(straightTestFeature).enabled) {
			board.set('straightProposals', []);
			return;
		}
		const assistance = board.has('straightTestTruthAssistance')
			? board.get<StraightTestTruthAssistance>('straightTestTruthAssistance')
			: ({ mode: 'blind', locks: [] } as StraightTestTruthAssistance);
		const truthAssisted = ctx.resolve(straightTestFeature).knobs.truthAssisted;
		if (assistance.mode === 'verified-canonical' && truthAssisted !== true)
			throw new Error('straightTest verified-canonical assistance requires truthAssisted=true');
		if (truthAssisted === true && assistance.mode !== 'verified-canonical')
			throw new Error('straightTest truth-assisted config requires verified canonical assistance');
		const badges = board.get<readonly BadgeEvidence[]>('badges');
		const tees = board.get<readonly TeeEvidence[]>('tees');
		const baskets = board.get<readonly BasketEvidence[]>('baskets');
		const proposals = badges.flatMap((badge) => {
			const candidateCount =
				tees.filter((tee) => tee.tier === 'ring').length *
				baskets.filter((basket) => basket.confidence === 'high').length;
			if (
				assistance.mode === 'verified-canonical' &&
				assistance.locks.some((lock) => lock.badgeId === badge.detId)
			) {
				return [
					evaluateStraightTestCandidate(
						candidateFromEvidence(
							badge,
							tees.find(
								(t) => t.detId === assistance.locks.find((l) => l.badgeId === badge.detId)?.teeId
							),
							baskets.find(
								(b) => b.detId === assistance.locks.find((l) => l.badgeId === badge.detId)?.basketId
							)
						),
						assistance,
						1
					)
				];
			}
			if (assistance.mode === 'verified-canonical') {
				const abstain = evaluateStraightTestCandidate(
					candidateFromEvidence(badge, undefined, undefined),
					{ mode: 'blind', locks: [] },
					0
				);
				return [
					{
						...abstain,
						truthTainted: true,
						reasons: [
							'TRUTH-TAINT: no verified canonical lock for identified badge; S0 abstains.',
							'No ownership or bend assertion.'
						]
					}
				];
			}
			return [
				evaluateStraightTestCandidate(
					candidateFromEvidence(badge, undefined, undefined),
					assistance,
					candidateCount
				)
			];
		});
		const drawableProposals = proposals.filter((proposal, index) => {
			if (proposal.selected) return true;
			if (proposals.some((other) => other.selected && other.badgeId === proposal.badgeId))
				return false;
			return proposals.findIndex((other) => other.badgeId === proposal.badgeId) === index;
		});
		for (const proposal of drawableProposals) {
			const e = proposal.geometryEndpoints;
			if (e) {
				const values = Object.fromEntries(
					Object.entries(proposal.measurements).filter(([, value]) => value !== null)
				) as Record<string, number>;
				ctx.overlay('straightTest', {
					type: 'polyline',
					path: [
						[e.tee.xPx, e.tee.yPx],
						[e.badge.xPx, e.badge.yPx]
					],
					verdict: proposal.selected ? 'accepted' : 'info',
					values,
					ref: `${proposal.proposalId}:tee-badge-ray`
				});
				ctx.overlay('straightTest', {
					type: 'polyline',
					path: [
						[e.tee.xPx, e.tee.yPx],
						[e.basket.xPx, e.basket.yPx]
					],
					verdict: proposal.selected ? 'accepted' : 'info',
					values,
					ref: `${proposal.proposalId}:tee-basket-chord`
				});
				if (proposal.measurements.f !== null) {
					const px = e.tee.xPx + (e.basket.xPx - e.tee.xPx) * proposal.measurements.f;
					const py = e.tee.yPx + (e.basket.yPx - e.tee.yPx) * proposal.measurements.f;
					ctx.overlay('straightTest', {
						type: 'polyline',
						path: [
							[e.badge.xPx, e.badge.yPx],
							[px, py]
						],
						verdict: 'info',
						values,
						ref: `${proposal.proposalId}:badge-projection-perp`
					});
				}
				if (e.tee.axisAngleRad !== null) {
					const ax = Math.cos(e.tee.axisAngleRad) * 20;
					const ay = Math.sin(e.tee.axisAngleRad) * 20;
					ctx.overlay('straightTest', {
						type: 'polyline',
						path: [
							[e.tee.xPx - ax, e.tee.yPx - ay],
							[e.tee.xPx + ax, e.tee.yPx + ay]
						],
						verdict: 'info',
						values,
						ref: `${proposal.proposalId}:tee-axis`
					});
				}
			} else {
				const badge = badges.find((candidate) => candidate.detId === proposal.badgeId);
				ctx.overlay('straightTest', {
					type: 'point',
					xPx: Number.isFinite(badge?.cxPx) ? badge!.cxPx : 0,
					yPx: Number.isFinite(badge?.cyPx) ? badge!.cyPx : 0,
					verdict: 'info',
					ref: `${proposal.proposalId}:abstain`,
					reason: 'ABSTAIN: endpoint evidence unavailable or invalid; no geometry selected.'
				});
			}
		}
		const trace: StraightTestTrace = {
			featureId: 'straightTest',
			coordinateFrame: STRAIGHT_TEST_COORDINATE_FRAME,
			truthAssistance: assistance,
			proposals
		};
		ctx.recordStraightTest?.(trace);
		board.set('straightProposals', proposals);
	}
};
