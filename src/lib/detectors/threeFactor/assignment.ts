import type {
	AssignmentEvidence,
	RecoveredTeeInput,
	ScoredPairEvidence,
	TeeEvidence,
	ThreeFactorAssignment,
	ThreeFactorMeasurement
} from './types';
import { routeBadgeLegs } from './routing';
import { makeRawPairEvidence, scorePair } from './scoring';

function recoveredTee(input: RecoveredTeeInput, index: number): TeeEvidence {
	const bbox = input.bbox ?? [Math.round(input.xPx - 6), Math.round(input.yPx - 6), 12, 12] as const;
	return {
		detId: `tee-recovered-${index}`,
		xPx: input.xPx,
		yPx: input.yPx,
		tier: 'recovered',
		angleRad: null,
		bbox,
		area: input.area ?? 0,
		fill: input.fill ?? 0,
		onRing: false,
		recovery: input.provenance
	};
}

function allScoredPairs(measurement: ThreeFactorMeasurement, tees: readonly TeeEvidence[]): ScoredPairEvidence[] {
	const scored: ScoredPairEvidence[] = [];
	const teePoints = tees.map((tee) => ({ id: tee.detId, xPx: tee.xPx, yPx: tee.yPx }));
	const basketPoints = measurement.baskets.map((basket) => ({ id: basket.detId, xPx: basket.tipXPx, yPx: basket.tipYPx }));
	for (const badge of measurement.badges) {
		const legs = routeBadgeLegs(measurement.field, { id: badge.detId, xPx: badge.cxPx, yPx: badge.cyPx }, teePoints, basketPoints, measurement.viewport.topPx);
		for (let teeIndex = 0; teeIndex < tees.length; teeIndex++) {
			for (let basketIndex = 0; basketIndex < measurement.baskets.length; basketIndex++) {
				const tee = tees[teeIndex];
				const basket = measurement.baskets[basketIndex];
				const raw = makeRawPairEvidence(measurement.field, badge, tee, basket, legs.tees[teeIndex], legs.baskets[basketIndex], measurement.parameters, measurement.viewport.topPx);
				scored.push(scorePair(raw, measurement.field, badge, tee, basket, measurement.baskets, measurement.parameters, measurement.viewport.topPx));
			}
		}
	}
	return scored;
}

function comparePairs(a: ScoredPairEvidence, b: ScoredPairEvidence): number {
	return b.score - a.score || b.raw.supportMean - a.raw.supportMean || a.raw.pairId.localeCompare(b.raw.pairId);
}

function pairKey(pair: ScoredPairEvidence): string {
	return `${pair.raw.teeId}:${pair.raw.basketId}`;
}

export function assignThreeFactor(
	measurement: ThreeFactorMeasurement,
	recoveredTees: readonly RecoveredTeeInput[] = []
): ThreeFactorAssignment {
	const explicit = [...recoveredTees]
		.sort((a, b) => a.yPx - b.yPx || a.xPx - b.xPx || a.provenance.note.localeCompare(b.provenance.note))
		.map((input, index) => recoveredTee(input, index));
	const tees = [...measurement.tees, ...explicit].sort((a, b) => a.yPx - b.yPx || a.xPx - b.xPx || a.detId.localeCompare(b.detId));
	const scoredPairs = allScoredPairs(measurement, tees);
	const byBadge = new Map<string, ScoredPairEvidence[]>();
	for (const pair of scoredPairs) {
		const list = byBadge.get(pair.raw.badgeId) ?? [];
		list.push(pair);
		byBadge.set(pair.raw.badgeId, list);
	}
	for (const list of byBadge.values()) {
		list.sort(comparePairs);
		for (let i = 0; i < list.length; i++) list[i] = { ...list[i], rank: i + 1 };
	}
	const badgeOrder = [...byBadge.entries()].sort((a, b) => {
		const aTop = a[1][0]?.score ?? 0;
		const bTop = b[1][0]?.score ?? 0;
		const aRival = a[1].find((pair) => pair.raw.teeId !== a[1][0]?.raw.teeId && pair.raw.basketId !== a[1][0]?.raw.basketId)?.score ?? 0;
		const bRival = b[1].find((pair) => pair.raw.teeId !== b[1][0]?.raw.teeId && pair.raw.basketId !== b[1][0]?.raw.basketId)?.score ?? 0;
		return (bTop - bRival) - (aTop - aRival) || a[0].localeCompare(b[0]);
	});
	const selected = new Map<string, ScoredPairEvidence>();
	const usedTees = new Set<string>();
	const usedBaskets = new Set<string>();
	for (const [badgeId, list] of badgeOrder) {
		const pair = list.find((candidate) => !usedTees.has(candidate.raw.teeId) && !usedBaskets.has(candidate.raw.basketId));
		if (!pair) continue;
		selected.set(badgeId, pair);
		usedTees.add(pair.raw.teeId);
		usedBaskets.add(pair.raw.basketId);
	}
	for (let pass = 0; pass < 2; pass++) {
		const rows = [...selected.entries()];
		let changed = false;
		for (let i = 0; i < rows.length; i++) {
			for (let j = i + 1; j < rows.length; j++) {
				const [badgeA, pairA] = rows[i];
				const [badgeB, pairB] = rows[j];
				const candidateA = (byBadge.get(badgeA) ?? []).find((pair) => pair.raw.teeId === pairB.raw.teeId && pair.raw.basketId === pairA.raw.basketId);
				const candidateB = (byBadge.get(badgeB) ?? []).find((pair) => pair.raw.teeId === pairA.raw.teeId && pair.raw.basketId === pairB.raw.basketId);
				if (candidateA && candidateB && candidateA.score + candidateB.score > pairA.score + pairB.score) {
					selected.set(badgeA, candidateA);
					selected.set(badgeB, candidateB);
					rows[i] = [badgeA, candidateA];
					rows[j] = [badgeB, candidateB];
					changed = true;
				}
			}
		}
		if (!changed) break;
	}
	const assignments: AssignmentEvidence[] = [...selected.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([badgeId, pair]) => ({
			badgeId,
			teeId: pair.raw.teeId,
			basketId: pair.raw.basketId,
			score: pair.score,
			rank: pair.rank,
			ownership: 'selected',
			alternatives: (byBadge.get(badgeId) ?? []).filter((candidate) => pairKey(candidate) !== pairKey(pair)).slice(0, 3).map((candidate) => ({ teeId: candidate.raw.teeId, basketId: candidate.raw.basketId, score: candidate.score }))
		}));
	return { measurement, tees, scoredPairs, assignments };
}
