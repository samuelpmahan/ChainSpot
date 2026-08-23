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
import { routeBadgeLegs } from './routing';
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
}

export const DEFAULT_SEARCH_KNOBS: SearchKnobs = {
	assignTopRows: 60,
	exchangeTopK: 12,
	maxAssignPasses: 60,
	recoveredTeeDedupeDistance: 14
};

function recoveredTee(
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

function rerouteRawPairs(
	measurement: ThreeFactorMeasurement,
	tees: readonly TeeEvidence[]
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
			measurement.viewport.topPx
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
						measurement.viewport.topPx
					)
				);
			}
		}
	}
	return rawPairs.sort((a, b) => a.pairId.localeCompare(b.pairId));
}

function scoreRawPairs(
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

function rankPairsByBadge(
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
	searchKnobs: SearchKnobs = DEFAULT_SEARCH_KNOBS
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
		? rerouteRawPairs(measurement, tees)
		: measurement.rawPairs;
	const scoredUnranked = scoreRawPairs(measurement, tees, rawPairs, zfitKnobs, scoringKnobs);
	const byBadge = rankPairsByBadge(scoredUnranked);
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
