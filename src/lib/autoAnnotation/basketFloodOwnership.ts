/**
 * Conservative basket ownership from the existing ribbon-mass component graph.
 *
 * This is deliberately much narrower than courseGrammar: it only locks a
 * basket when one raw connected component touches exactly one numbered badge
 * and exactly one basket candidate. Shared components, split corridors, and
 * seed misses are not guessed; they fall through to the existing grammar/UI.
 *
 * The rule was first falsified in scripts/cv-probes/basket_floodfill_ownership.py
 * against two independent labeled courses using shuffled, unlabeled basket
 * candidate pools. It produced 8/8 correct locks on GoldenTeeSet and 3/3 on
 * AlexClarkSet, with zero false locks. The low coverage is intentional: this
 * is a structural pre-assignment layer, not a replacement for grammar.
 */
import {
	DEFAULT_RIBBON_MASS_PARAMS,
	placeSeeds,
	type RibbonMassSegmentation
} from './ribbonMass';

export interface BasketFloodBadge {
	readonly holeNumber: number;
	readonly xPx: number;
	readonly yPx: number;
}

export interface BasketFloodCandidate {
	readonly xPx: number;
	readonly yPx: number;
}

export interface BasketFloodLock {
	readonly holeNumber: number;
	readonly basketCandidateIndex: number;
	readonly componentLabel: number;
}

export interface BasketFloodAmbiguity {
	readonly componentLabel: number;
	readonly holeNumbers: readonly number[];
	readonly basketCandidateIndexes: readonly number[];
}

export interface BasketFloodOwnershipResult {
	readonly locks: readonly BasketFloodLock[];
	readonly ambiguousComponents: readonly BasketFloodAmbiguity[];
	readonly badgeSeedMissHoleNumbers: readonly number[];
	readonly basketSeedMissCandidateIndexes: readonly number[];
}

/**
 * Find zero-guess basket ownership locks on an already-segmented ribbon mass.
 * Candidate array position is preserved as the returned basketCandidateIndex.
 */
export function findExclusiveBasketFloodOwnership(
	segmentation: Pick<RibbonMassSegmentation, 'labels' | 'widthEv' | 'heightEv' | 'scale'>,
	badges: readonly BasketFloodBadge[],
	baskets: readonly BasketFloodCandidate[],
	seedRadiusPx = DEFAULT_RIBBON_MASS_PARAMS.seedRadiusPx
): BasketFloodOwnershipResult {
	const badgeSeeds = badges.map((badge) => ({
		seedId: `badge:${badge.holeNumber}`,
		kind: 'badge' as const,
		holeNumber: badge.holeNumber,
		xPx: badge.xPx,
		yPx: badge.yPx
	}));
	const basketSeeds = baskets.map((basket, index) => ({
		seedId: `basket:${index}`,
		kind: 'basket' as const,
		holeNumber: null,
		xPx: basket.xPx,
		yPx: basket.yPx
	}));
	const placements = placeSeeds(segmentation, [...badgeSeeds, ...basketSeeds], seedRadiusPx);

	const holeNumbersByComponent = new Map<number, Set<number>>();
	const basketIndexesByComponent = new Map<number, number[]>();
	const badgeSeedMissHoleNumbers: number[] = [];
	const basketSeedMissCandidateIndexes: number[] = [];

	for (const placement of placements) {
		if (placement.kind === 'badge') {
			const holeNumber = placement.holeNumber;
			if (holeNumber === null) continue;
			if (placement.componentLabel === null) {
				badgeSeedMissHoleNumbers.push(holeNumber);
				continue;
			}
			let holes = holeNumbersByComponent.get(placement.componentLabel);
			if (!holes) {
				holes = new Set<number>();
				holeNumbersByComponent.set(placement.componentLabel, holes);
			}
			holes.add(holeNumber);
			continue;
		}

		const index = Number(placement.seedId.slice('basket:'.length));
		if (!Number.isInteger(index) || index < 0 || index >= baskets.length) continue;
		if (placement.componentLabel === null) {
			basketSeedMissCandidateIndexes.push(index);
			continue;
		}
		let indexes = basketIndexesByComponent.get(placement.componentLabel);
		if (!indexes) {
			indexes = [];
			basketIndexesByComponent.set(placement.componentLabel, indexes);
		}
		indexes.push(index);
	}

	const locks: BasketFloodLock[] = [];
	const ambiguousComponents: BasketFloodAmbiguity[] = [];
	const labels = new Set<number>([
		...holeNumbersByComponent.keys(),
		...basketIndexesByComponent.keys()
	]);
	for (const componentLabel of [...labels].sort((a, b) => a - b)) {
		const holeNumbers = [...(holeNumbersByComponent.get(componentLabel) ?? [])].sort((a, b) => a - b);
		const basketCandidateIndexes = [...(basketIndexesByComponent.get(componentLabel) ?? [])].sort((a, b) => a - b);
		if (holeNumbers.length === 1 && basketCandidateIndexes.length === 1) {
			locks.push({
				holeNumber: holeNumbers[0],
				basketCandidateIndex: basketCandidateIndexes[0],
				componentLabel
			});
		} else if (holeNumbers.length > 0 && basketCandidateIndexes.length > 0) {
			ambiguousComponents.push({ componentLabel, holeNumbers, basketCandidateIndexes });
		}
	}

	return {
		locks,
		ambiguousComponents,
		badgeSeedMissHoleNumbers: badgeSeedMissHoleNumbers.sort((a, b) => a - b),
		basketSeedMissCandidateIndexes: basketSeedMissCandidateIndexes.sort((a, b) => a - b)
	};
}
