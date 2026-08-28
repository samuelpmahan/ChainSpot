import type {
	AssignmentEvidence,
	BasketEvidence,
	CorridorParams,
	RawPairEvidence,
	RecoveredTeeInput,
	ScoredPairEvidence,
	TeeEvidence,
	ThreeFactorAssignment,
	ThreeFactorMeasurement
} from './types';
import { DEFAULT_ROUTING_KNOBS, routeBadgeLegs, type RoutingKnobs } from './routing';
import { DEFAULT_RIBBON_KNOBS, type RibbonKnobs } from './ribbon';
import {
	DEFAULT_SCORING_KNOBS,
	DEFAULT_ZFIT_KNOBS,
	makeRawPairEvidence,
	scorePair,
	type ScoringKnobs,
	type ZfitKnobs
} from './scoring';

const IMPROVEMENT_EPSILON = 1e-9;

export interface SearchKnobs {
	readonly assignTopRows: number;
	readonly exchangeTopK: number;
	readonly maxAssignPasses: number;
	readonly recoveredTeeDedupeDistance: number;
	readonly padClaimOutlierFactor: number;
}

export const DEFAULT_SEARCH_KNOBS: SearchKnobs = {
	assignTopRows: 60,
	exchangeTopK: 12,
	maxAssignPasses: 60,
	recoveredTeeDedupeDistance: 14,
	padClaimOutlierFactor: 3
};

export interface GeometricClaim {
	readonly badgeId: string;
	readonly badgeLabel: string | null;
	readonly teeId: string;
	readonly distancePx: number;
}

export interface GeometricClaimSet {
	readonly claims: readonly GeometricClaim[];
	readonly medianClaimDistancePx: number | null;
	/** medianClaimDistancePx x padClaimOutlierFactor; null when no claims
	 * exist to derive it from (then nothing may be pruned by it). */
	readonly claimBoundPx: number | null;
}

/** Greedy nearest badge<->tee claiming, the single geometric ground truth
 * shared by teeRecovery's hunted-set derivation AND assignment's pair
 * plausibility prune (owner directive 2026-08-28: detection geometry decides
 * who is missing and what is pairable, never the solver's own scores). The
 * bound is course-derived -- median claimed distance on THIS run x factor --
 * never an absolute pixel literal (150ft holes and 1700ft holes exist). */
export function deriveGeometricClaims(
	badges: readonly { readonly detId: string; readonly label?: string | null; readonly cxPx: number; readonly cyPx: number }[],
	tees: readonly TeeEvidence[],
	padClaimOutlierFactor: number
): GeometricClaimSet {
	const pairs = badges
		.flatMap((badge) => tees.map((tee) => ({
			badge,
			tee,
			distancePx: Math.hypot(tee.xPx - badge.cxPx, tee.yPx - badge.cyPx)
		})))
		.sort((a, b) =>
			a.distancePx - b.distancePx ||
			a.badge.detId.localeCompare(b.badge.detId) ||
			a.tee.detId.localeCompare(b.tee.detId)
		);
	const claimedBadges = new Set<string>();
	const claimedTees = new Set<string>();
	const claims: GeometricClaim[] = [];
	for (const pair of pairs) {
		if (claimedBadges.has(pair.badge.detId) || claimedTees.has(pair.tee.detId)) continue;
		claimedBadges.add(pair.badge.detId);
		claimedTees.add(pair.tee.detId);
		claims.push({
			badgeId: pair.badge.detId,
			badgeLabel: pair.badge.label ?? null,
			teeId: pair.tee.detId,
			distancePx: pair.distancePx
		});
	}
	const distances = claims.map((claim) => claim.distancePx).sort((a, b) => a - b);
	const medianClaimDistancePx = distances.length ? distances[Math.floor(distances.length / 2)]! : null;
	const claimBoundPx = medianClaimDistancePx === null ? null : medianClaimDistancePx * padClaimOutlierFactor;
	return { claims, medianClaimDistancePx, claimBoundPx };
}

export interface PlausibilityDropRecord {
	readonly badgeId: string;
	readonly teeId: string;
	readonly distancePx: number;
	readonly pairCount: number;
	readonly bestScore: number;
	readonly rule: 'beyond-claim-bound' | 'recovered-tee-bound-elsewhere';
}

export interface PlausibilityPrune {
	readonly kept: readonly ScoredPairEvidence[];
	/** One record per dropped (badge, tee) pairing -- provenance exists to
	 * track candidates and name every drop-out, never to celebrate the
	 * survivors. Callers must surface these in receipts. */
	readonly dropped: readonly PlausibilityDropRecord[];
	readonly claimSet: GeometricClaimSet;
	readonly padClaimOutlierFactor: number;
}

/** Remove geometrically implausible (badge, tee) pairings before selection.
 * Two rules, each named on every drop record:
 * - 'recovered-tee-bound-elsewhere': a recovered tee was accepted BECAUSE
 *   every visible pixel fits a pose pointing at one specific badge; pairing
 *   it with any other badge discards that proof (the Heritage H18/H6 swap).
 * - 'beyond-claim-bound': the tee sits farther from the badge than the
 *   course-derived claim bound (median greedy-claim distance x
 *   padClaimOutlierFactor); a scarcity-driven 317px "rank 1" pairing
 *   (Heritage H5 <- tee-12, ledger row 27) must lose to an empty slot the
 *   recovery hunt can then see. With no derivable bound nothing is pruned
 *   by distance. */
export function pruneImplausiblePairs(
	badges: readonly { readonly detId: string; readonly label?: string | null; readonly cxPx: number; readonly cyPx: number }[],
	tees: readonly TeeEvidence[],
	scored: readonly ScoredPairEvidence[],
	padClaimOutlierFactor: number
): PlausibilityPrune {
	const claimSet = deriveGeometricClaims(badges, tees, padClaimOutlierFactor);
	const badgeById = new Map(badges.map((badge) => [badge.detId, badge]));
	const teeById = new Map(tees.map((tee) => [tee.detId, tee]));
	const kept: ScoredPairEvidence[] = [];
	const droppedByPairing = new Map<string, { badgeId: string; teeId: string; distancePx: number; pairCount: number; bestScore: number; rule: PlausibilityDropRecord['rule'] }>();
	for (const pair of scored) {
		const badge = badgeById.get(pair.raw.badgeId);
		const tee = teeById.get(pair.raw.teeId);
		const boundBadgeId = tee?.tier === 'recovered' ? tee.recovery?.badgeId : undefined;
		const distancePx = badge && tee ? Math.hypot(tee.xPx - badge.cxPx, tee.yPx - badge.cyPx) : Number.NaN;
		let rule: PlausibilityDropRecord['rule'] | null = null;
		if (boundBadgeId !== undefined && boundBadgeId !== pair.raw.badgeId) rule = 'recovered-tee-bound-elsewhere';
		else if (
			boundBadgeId === undefined &&
			claimSet.claimBoundPx !== null &&
			Number.isFinite(distancePx) &&
			distancePx > claimSet.claimBoundPx
		) rule = 'beyond-claim-bound';
		if (rule === null) { kept.push(pair); continue; }
		const key = `${pair.raw.badgeId}|${pair.raw.teeId}`;
		const record = droppedByPairing.get(key);
		if (record) {
			record.pairCount += 1;
			record.bestScore = Math.max(record.bestScore, pair.score);
		} else {
			droppedByPairing.set(key, { badgeId: pair.raw.badgeId, teeId: pair.raw.teeId, distancePx, pairCount: 1, bestScore: pair.score, rule });
		}
	}
	return { kept, dropped: [...droppedByPairing.values()], claimSet, padClaimOutlierFactor };
}

export function recoveredTee(
	input: RecoveredTeeInput,
	index: number,
	baskets: readonly BasketEvidence[],
	knobs: ScoringKnobs
): TeeEvidence {
	const bbox = input.bbox ?? [
		Math.round(input.xPx - knobs.fallbackTeeBboxOffset),
		Math.round(input.yPx - knobs.fallbackTeeBboxOffset),
		knobs.fallbackTeeBboxSize,
		knobs.fallbackTeeBboxSize
	] as const;
	return {
		detId: `tee-recovered-${index}`,
		xPx: input.xPx,
		yPx: input.yPx,
		tier: 'recovered',
		angleRad: null,
		bbox,
		area: input.area ?? 0,
		fill: input.fill ?? 0,
		onRing: baskets.some(
			(basket) => Math.abs(Math.hypot(input.xPx - basket.tipXPx, input.yPx - basket.tipYPx) - knobs.ringDistance) <= knobs.ringTolerance
		),
		recovery: input.provenance
	};
}

function comparePairs(a: ScoredPairEvidence, b: ScoredPairEvidence): number {
	return b.score - a.score || b.raw.supportMean - a.raw.supportMean || a.raw.pairId.localeCompare(b.raw.pairId);
}

function pairKey(pair: ScoredPairEvidence): string {
	return `${pair.raw.teeId}:${pair.raw.basketId}`;
}

export function rerouteRawPairs(
	measurement: ThreeFactorMeasurement,
	tees: readonly TeeEvidence[],
	ribbonKnobs: RibbonKnobs,
	routingKnobs: RoutingKnobs,
	scoringKnobs: ScoringKnobs
): RawPairEvidence[] {
	const rawPairs: RawPairEvidence[] = [];
	const teePoints = tees.map((tee) => ({ id: tee.detId, xPx: tee.xPx, yPx: tee.yPx }));
	const basketPoints = measurement.baskets.map((basket) => ({
		id: basket.detId,
		xPx: basket.tipXPx,
		yPx: basket.tipYPx
	}));
	for (const badge of measurement.badges) {
		const legs = routeBadgeLegs(
			measurement.field,
			{ id: badge.detId, xPx: badge.cxPx, yPx: badge.cyPx },
			teePoints,
			basketPoints,
			measurement.viewport.topPx,
			ribbonKnobs,
			routingKnobs
		);
		for (let teeIndex = 0; teeIndex < tees.length; teeIndex++) {
			for (let basketIndex = 0; basketIndex < measurement.baskets.length; basketIndex++) {
				rawPairs.push(
					makeRawPairEvidence(
						measurement.field,
						badge,
						tees[teeIndex],
						measurement.baskets[basketIndex],
						legs.tees[teeIndex],
						legs.baskets[basketIndex],
						measurement.parameters,
						measurement.viewport.topPx,
						scoringKnobs
					)
				);
			}
		}
	}
	return rawPairs.sort((a, b) => a.pairId.localeCompare(b.pairId));
}

export function scoreRawPairs(
	measurement: ThreeFactorMeasurement,
	tees: readonly TeeEvidence[],
	rawPairs: readonly RawPairEvidence[],
	zfitKnobs: ZfitKnobs = DEFAULT_ZFIT_KNOBS,
	scoringKnobs: ScoringKnobs = DEFAULT_SCORING_KNOBS
): ScoredPairEvidence[] {
	const badges = new Map(measurement.badges.map((badge) => [badge.detId, badge]));
	const teesById = new Map(tees.map((tee) => [tee.detId, tee]));
	const baskets = new Map(measurement.baskets.map((basket) => [basket.detId, basket]));
	const baseParameters: CorridorParams = measurement.parameters.zfit
		? { ...measurement.parameters, zfit: false }
		: measurement.parameters;
	const scored: ScoredPairEvidence[] = rawPairs.map((raw) => {
		const badge = badges.get(raw.badgeId);
		const tee = teesById.get(raw.teeId);
		const basket = baskets.get(raw.basketId);
		if (!badge || !tee || !basket) {
			throw new Error(`Raw pair references missing endpoint evidence: ${raw.pairId}`);
		}
		return scorePair(
			raw,
			measurement.field,
			badge,
			tee,
			basket,
			measurement.baskets,
			baseParameters,
			measurement.viewport.topPx,
			false,
			scoringKnobs,
			zfitKnobs
		);
	});

	if (!measurement.parameters.zfit) return scored;

	const salvage = scored
		.map((row, index) => ({ row, index }))
		.sort((a, b) => b.row.score - a.row.score || a.row.raw.pairId.localeCompare(b.row.raw.pairId))
		.slice(0, zfitKnobs.topK);
	for (const { row, index } of salvage) {
		const alignedWorst = row.raw.worstWindowMean > 0
			? row.raw.worstWindowMean * row.factors.alignment
			: 0;
		if (alignedWorst <= 0 || row.score <= 0 || alignedWorst >= zfitKnobs.alignedWorstCeiling) continue;
		const badge = badges.get(row.raw.badgeId);
		const tee = teesById.get(row.raw.teeId);
		const basket = baskets.get(row.raw.basketId);
		if (!badge || !tee || !basket) continue;
		scored[index] = scorePair(
			row.raw,
			measurement.field,
			badge,
			tee,
			basket,
			measurement.baskets,
			measurement.parameters,
			measurement.viewport.topPx,
			true,
			scoringKnobs,
			zfitKnobs
		);
	}
	return scored;
}

export function rankPairsByBadge(
	scoredPairs: readonly ScoredPairEvidence[]
): Map<string, ScoredPairEvidence[]> {
	const byBadge = new Map<string, ScoredPairEvidence[]>();
	for (const pair of scoredPairs) {
		const list = byBadge.get(pair.raw.badgeId) ?? [];
		list.push(pair);
		byBadge.set(pair.raw.badgeId, list);
	}
	for (const [badgeId, list] of byBadge) {
		const ranked = [...list]
			.sort(comparePairs)
			.map((pair, index) => ({ ...pair, rank: index + 1 }));
		byBadge.set(badgeId, ranked);
	}
	return byBadge;
}

export function rankScoredPairs(
	scoredPairs: readonly ScoredPairEvidence[]
): ScoredPairEvidence[] {
	return [...rankPairsByBadge(scoredPairs).values()].flat();
}

export function selectAssignments(
	rescoredByBadge: ReadonlyMap<string, readonly ScoredPairEvidence[]>,
	knobs: SearchKnobs = DEFAULT_SEARCH_KNOBS
): Map<string, ScoredPairEvidence | null> {
	const labels = [...rescoredByBadge.keys()];
	const margin = (label: string): number => {
		const rows = [...(rescoredByBadge.get(label) ?? [])].sort(comparePairs);
		const top = rows[0];
		if (!top) return 0;
		const rival = rows.find(
			(row) => row.raw.teeId !== top.raw.teeId && row.raw.basketId !== top.raw.basketId
		);
		return top.score - (rival?.score ?? 0);
	};

	const solveFrom = (order: readonly string[]): Map<string, ScoredPairEvidence | null> => {
		const pick = new Map<string, ScoredPairEvidence | null>(labels.map((label) => [label, null]));
		const usedTees = new Set<string>();
		const usedBaskets = new Set<string>();
		for (const label of order) {
			let best: ScoredPairEvidence | null = null;
			for (const row of rescoredByBadge.get(label) ?? []) {
				if (usedTees.has(row.raw.teeId) || usedBaskets.has(row.raw.basketId)) continue;
				if (!best || comparePairs(row, best) < 0) best = row;
			}
			if (!best) continue;
			pick.set(label, best);
			usedTees.add(best.raw.teeId);
			usedBaskets.add(best.raw.basketId);
		}

		const topRows = new Map(
			labels.map((label) => [
				label,
				[...(rescoredByBadge.get(label) ?? [])].sort(comparePairs).slice(0, knobs.assignTopRows)
			])
		);
		let improved = true;
		let guard = 0;
		while (improved && guard++ < knobs.maxAssignPasses) {
			improved = false;

			for (const label of labels) {
				const current = pick.get(label) ?? null;
				if (current) {
					usedTees.delete(current.raw.teeId);
					usedBaskets.delete(current.raw.basketId);
				}
				let best: ScoredPairEvidence | null = null;
				for (const row of topRows.get(label) ?? []) {
					if (usedTees.has(row.raw.teeId) || usedBaskets.has(row.raw.basketId)) continue;
					if (!best || comparePairs(row, best) < 0) best = row;
				}
				if (best && (!current || best.score > current.score + IMPROVEMENT_EPSILON)) {
					pick.set(label, best);
					improved = true;
				} else {
					pick.set(label, current);
				}
				const now = pick.get(label);
				if (now) {
					usedTees.add(now.raw.teeId);
					usedBaskets.add(now.raw.basketId);
				}
			}

			for (let i = 0; i < labels.length; i++) {
				for (let j = i + 1; j < labels.length; j++) {
					const labelA = labels[i];
					const labelB = labels[j];
					const currentA = pick.get(labelA) ?? null;
					const currentB = pick.get(labelB) ?? null;
					const base = (currentA?.score ?? 0) + (currentB?.score ?? 0);
					for (const current of [currentA, currentB]) {
						if (!current) continue;
						usedTees.delete(current.raw.teeId);
						usedBaskets.delete(current.raw.basketId);
					}
					let bestPair: [
						ScoredPairEvidence | null,
						ScoredPairEvidence | null
					] = [currentA, currentB];
					let bestTotal = base;
					const rowsA = (topRows.get(labelA) ?? []).slice(0, knobs.exchangeTopK);
					const rowsB = (topRows.get(labelB) ?? []).slice(0, knobs.exchangeTopK);
					for (const rowA of rowsA) {
						if (usedTees.has(rowA.raw.teeId) || usedBaskets.has(rowA.raw.basketId)) continue;
						for (const rowB of rowsB) {
							if (
								rowB.raw.teeId === rowA.raw.teeId ||
								rowB.raw.basketId === rowA.raw.basketId
							) continue;
							if (usedTees.has(rowB.raw.teeId) || usedBaskets.has(rowB.raw.basketId)) continue;
							const total = rowA.score + rowB.score;
							if (total > bestTotal + IMPROVEMENT_EPSILON) {
								bestTotal = total;
								bestPair = [rowA, rowB];
							}
						}
					}
					if (bestPair[0] !== currentA || bestPair[1] !== currentB) improved = true;
					pick.set(labelA, bestPair[0]);
					pick.set(labelB, bestPair[1]);
					for (const current of bestPair) {
						if (!current) continue;
						usedTees.add(current.raw.teeId);
						usedBaskets.add(current.raw.basketId);
					}
				}
			}
		}
		return pick;
	};

	const total = (pick: ReadonlyMap<string, ScoredPairEvidence | null>): number =>
		[...pick.values()].reduce((sum, row) => sum + (row?.score ?? 0), 0);
	const marginOrder = [...labels].sort((a, b) => margin(b) - margin(a));
	const starts: readonly string[][] = [marginOrder, [...labels], [...labels].reverse()];
	let bestPick = solveFrom(starts[0]);
	for (const order of starts.slice(1)) {
		const candidate = solveFrom(order);
		if (total(candidate) > total(bestPick)) bestPick = candidate;
	}
	return bestPick;
}

export function assignThreeFactor(
	measurement: ThreeFactorMeasurement,
	recoveredTees: readonly RecoveredTeeInput[] = [],
	zfitKnobs?: ZfitKnobs,
	scoringKnobs: ScoringKnobs = DEFAULT_SCORING_KNOBS,
	searchKnobs: SearchKnobs = DEFAULT_SEARCH_KNOBS,
	ribbonKnobs: RibbonKnobs = DEFAULT_RIBBON_KNOBS,
	routingKnobs: RoutingKnobs = DEFAULT_ROUTING_KNOBS,
	/** Receipt seam: every geometrically pruned (badge, tee) pairing is
	 * reported here so the caller can surface the drop-outs -- provenance
	 * tracks candidates leaving the pool, not just the survivors. */
	onPrune?: (prune: PlausibilityPrune) => void
): ThreeFactorAssignment {
	const sortedRecovered = [...recoveredTees].sort(
		(a, b) =>
			a.yPx - b.yPx ||
			a.xPx - b.xPx ||
			a.provenance.note.localeCompare(b.provenance.note)
	);
	const tees: TeeEvidence[] = [...measurement.tees];
	let acceptedRecovered = 0;
	for (const input of sortedRecovered) {
		if (tees.some((tee) => Math.hypot(tee.xPx - input.xPx, tee.yPx - input.yPx) < searchKnobs.recoveredTeeDedupeDistance)) continue;
		tees.push(recoveredTee(input, acceptedRecovered++, measurement.baskets, scoringKnobs));
	}
	tees.sort((a, b) => a.yPx - b.yPx || a.xPx - b.xPx || a.detId.localeCompare(b.detId));

	const rawPairs = acceptedRecovered > 0
		? rerouteRawPairs(measurement, tees, ribbonKnobs, routingKnobs, scoringKnobs)
		: measurement.rawPairs;
	const scoredUnranked = scoreRawPairs(measurement, tees, rawPairs, zfitKnobs, scoringKnobs);
	const configuredFactor = searchKnobs?.padClaimOutlierFactor;
	const prune = pruneImplausiblePairs(
		measurement.badges,
		tees,
		scoredUnranked,
		typeof configuredFactor === 'number' && Number.isFinite(configuredFactor) ? configuredFactor : DEFAULT_SEARCH_KNOBS.padClaimOutlierFactor
	);
	onPrune?.(prune);
	const byBadge = rankPairsByBadge(prune.kept);
	const scoredPairs = [...byBadge.values()].flat();
	const selected = selectAssignments(byBadge, searchKnobs);
	const assignments: AssignmentEvidence[] = [...selected.entries()]
		.filter((entry): entry is [string, ScoredPairEvidence] => entry[1] !== null)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([badgeId, pair]) => ({
			badgeId,
			teeId: pair.raw.teeId,
			basketId: pair.raw.basketId,
			score: pair.score,
			rank: pair.rank,
			ownership: 'selected',
			alternatives: (byBadge.get(badgeId) ?? [])
				.filter((candidate) => pairKey(candidate) !== pairKey(pair))
				.slice(0, 3)
				.map((candidate) => ({
					teeId: candidate.raw.teeId,
					basketId: candidate.raw.basketId,
					score: candidate.score
				}))
		}));
	return { measurement, tees, scoredPairs, assignments };
}
