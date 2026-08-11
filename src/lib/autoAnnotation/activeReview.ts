import type { CourseDetectionResult } from './basketDetection';

export type ActiveReviewLandmarkKind = 'tee' | 'basket';

export interface ActiveReviewPoint {
	readonly xPx: number;
	readonly yPx: number;
}

export interface ActiveReviewCandidate extends ActiveReviewPoint {
	readonly id: string;
	readonly kind: ActiveReviewLandmarkKind;
	readonly candidateIndex?: number;
	/** Tee-pad major axis, used as an undirected line pointing toward its badge. */
	readonly orientationDeg?: number;
	readonly score: number;
}

export interface ActiveReviewAssociation {
	readonly candidateId: string;
	readonly kind: ActiveReviewLandmarkKind;
	/** Relative evidence for this hole/candidate edge, not calibrated confidence. */
	readonly score: number;
}

export interface ActiveReviewHole {
	readonly number: number;
	readonly anchor?: ActiveReviewPoint;
	readonly status: 'ready' | 'review' | 'incomplete';
	readonly confidence: number;
	readonly missing: readonly ActiveReviewLandmarkKind[];
	readonly associations: readonly ActiveReviewAssociation[];
}

export interface ActiveReviewMap {
	readonly holes: readonly ActiveReviewHole[];
	readonly candidates: readonly ActiveReviewCandidate[];
	readonly confirmedHoleNumbers?: readonly number[];
	readonly confirmedCandidateIds?: readonly string[];
}

export interface ActiveReviewRationale {
	readonly affectedAssociationCount: number;
	readonly competingHoleCount: number;
	readonly ambiguity: number;
	readonly missingTee: boolean;
	readonly targetConfidence: number;
	readonly targetStatus: ActiveReviewHole['status'];
}

export interface TeeInvariantStat {
	readonly holeNumber: number;
	readonly teeCandidateIndex: number;
	readonly axisAlignment: number;
	readonly assignedDistancePx: number;
	readonly nearestAlternativeDistancePx: number | null;
	readonly distanceMarginPx: number | null;
	readonly distanceRank: number;
	readonly detectorScore: number;
	readonly grammarConfidence: number;
}

export type ActiveReviewRecommendation =
	| {
			readonly kind: 'candidate';
			readonly candidateKind: ActiveReviewLandmarkKind;
			readonly candidateId: string;
			readonly candidateIndex: number;
			readonly holeNumber: number;
			readonly score: number;
			readonly belowThreshold: boolean;
			readonly timedOut: boolean;
			readonly rationale: ActiveReviewRationale;
		}
	| {
			readonly kind: 'none';
			readonly holeNumber?: undefined;
			readonly score: 0;
			readonly timedOut: boolean;
			readonly reason: 'deadline' | 'no-useful-candidate';
			readonly rationale: ActiveReviewRationale;
		};

export interface ActiveReviewOptions {
	/** The browser-facing calculation budget. This is never a review cap. */
	readonly deadlineMs?: number;
	/** Minimum normalized usefulness score required for an automatic suggestion. */
	readonly minAutoSuggestScore?: number;
	/** Injectable for deterministic CLI and unit tests. */
	readonly now?: () => number;
}

interface CandidateStats {
	readonly uncertainty: number;
	readonly links: readonly { holeNumber: number; score: number }[];
}

const DEFAULT_DEADLINE_MS = 4000;
const DEFAULT_MIN_AUTO_SUGGEST_SCORE = 0.6;
const UNASSIGNED_PRIOR = 0.2;
const MIN_ACTIVE_REVIEW_LINK_RADIUS_PX = 80;
const MAX_ACTIVE_REVIEW_LINK_RADIUS_PX = 320;

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function pointDistance(a: ActiveReviewPoint, b: ActiveReviewPoint): number {
	return Math.hypot(a.xPx - b.xPx, a.yPx - b.yPx);
}

function entropy(probabilities: readonly number[]): number {
	if (probabilities.length <= 1) return 0;
	const raw = probabilities.reduce((sum, probability) => {
		if (probability <= 0) return sum;
		return sum - probability * Math.log(probability);
	}, 0);
	const maximum = Math.log(probabilities.length);
	return maximum === 0 ? 0 : clamp01(raw / maximum);
}

function associationScore(score: number): number {
	return clamp01(score) * 0.85 + 0.15;
}

function teeBadgeAlignment(candidate: ActiveReviewCandidate, badge: ActiveReviewPoint | undefined): number {
	if (candidate.kind !== 'tee' || candidate.orientationDeg === undefined || !badge) return 0.5;
	const teeToBadge = Math.atan2(badge.yPx - candidate.yPx, badge.xPx - candidate.xPx);
	const teeAxis = (candidate.orientationDeg * Math.PI) / 180;
	// Tee rectangles do not encode a front/back direction, so use the acute
	// angle: either end of the major axis can point at the number badge.
	return clamp01(Math.abs(Math.cos(teeToBadge - teeAxis)));
}

function endpointAssociationScore(
	baseScore: number,
	candidate: ActiveReviewCandidate,
	badge: ActiveReviewPoint | undefined
): number {
	const directness = candidate.kind === 'tee' ? teeBadgeAlignment(candidate, badge) : 1;
	return clamp01(baseScore * (0.25 + directness * 0.75));
}

/** Returns browser-console-friendly evidence for deciding whether tee placement can be trusted automatically. */
export function summarizeTeeInvariant(detection: CourseDetectionResult): readonly TeeInvariantStat[] {
	return detection.grammar.holes.flatMap((proposal) => {
		if (!proposal.numberBadge || !proposal.tee) return [];
		const assignedCandidate = detection.tees[proposal.tee.candidateIndex];
		if (!assignedCandidate) return [];
		const distances = detection.tees
			.map((candidate, index) => ({ index, distance: pointDistance(proposal.numberBadge!, candidate) }))
			.sort((left, right) => left.distance - right.distance);
		const assignedDistance = pointDistance(proposal.numberBadge, assignedCandidate);
		const nearestAlternative = distances.find((entry) => entry.index !== proposal.tee!.candidateIndex);
		return [{
			holeNumber: proposal.number,
			teeCandidateIndex: proposal.tee.candidateIndex,
			axisAlignment: Number(teeBadgeAlignment({
				id: `tee:${proposal.tee.candidateIndex}`,
				kind: 'tee',
				candidateIndex: proposal.tee.candidateIndex,
				xPx: assignedCandidate.xPx,
				yPx: assignedCandidate.yPx,
				orientationDeg: assignedCandidate.orientationDeg,
				score: candidateScore(assignedCandidate)
			}, proposal.numberBadge).toFixed(3)),
			assignedDistancePx: Number(assignedDistance.toFixed(1)),
			nearestAlternativeDistancePx: nearestAlternative ? Number(nearestAlternative.distance.toFixed(1)) : null,
			distanceMarginPx: nearestAlternative ? Number((nearestAlternative.distance - assignedDistance).toFixed(1)) : null,
			distanceRank: distances.findIndex((entry) => entry.index === proposal.tee!.candidateIndex) + 1,
			detectorScore: Number(candidateScore(assignedCandidate).toFixed(3)),
			grammarConfidence: Number(proposal.tee.confidence.toFixed(3))
		}];
	});
}

function candidateStats(map: ActiveReviewMap): Map<string, CandidateStats> {
	const links = new Map<string, Array<{ holeNumber: number; score: number }>>();
	for (const hole of map.holes) {
		const perCandidate = new Map<string, number>();
		for (const association of hole.associations) {
			const score = Math.max(perCandidate.get(association.candidateId) ?? 0, associationScore(association.score));
			perCandidate.set(association.candidateId, score);
		}
		for (const [candidateId, score] of perCandidate) {
			const bucket = links.get(candidateId) ?? [];
			bucket.push({ holeNumber: hole.number, score });
			links.set(candidateId, bucket);
		}
	}

	const result = new Map<string, CandidateStats>();
	for (const [candidateId, candidateLinks] of links) {
		const weights = [UNASSIGNED_PRIOR, ...candidateLinks.map((link) => link.score)];
		const total = weights.reduce((sum, weight) => sum + weight, 0);
		const probabilities = weights.map((weight) => weight / total);
		result.set(candidateId, {
			uncertainty: entropy(probabilities),
			links: candidateLinks
		});
	}
	return result;
}

function confirmedCandidateSet(map: ActiveReviewMap): Set<string> {
	return new Set(map.confirmedCandidateIds ?? []);
}

function noneRecommendation(timedOut: boolean, reason: 'deadline' | 'no-useful-candidate'): ActiveReviewRecommendation {
	return {
		kind: 'none',
		score: 0,
		timedOut,
		reason,
		rationale: {
			affectedAssociationCount: 0,
			competingHoleCount: 0,
			ambiguity: 0,
			missingTee: false,
			targetConfidence: 0,
			targetStatus: 'incomplete'
		}
	};
}

function candidateIndex(candidateId: string, candidate: ActiveReviewCandidate | undefined): number {
	if (candidate?.candidateIndex !== undefined) return candidate.candidateIndex;
	const parsed = Number(candidateId.split(':')[1]);
	return Number.isInteger(parsed) ? parsed : -1;
}

function recommendationFromBest(
	best: { candidate: ActiveReviewCandidate; holeNumber: number; score: number; rationale: ActiveReviewRationale },
	minAutoSuggestScore: number,
	timedOut: boolean
): ActiveReviewRecommendation {
	return {
		kind: 'candidate',
		candidateKind: best.candidate.kind,
		candidateId: best.candidate.id,
		candidateIndex: candidateIndex(best.candidate.id, best.candidate),
		holeNumber: best.holeNumber,
		score: best.score,
		belowThreshold: best.score < minAutoSuggestScore,
		timedOut,
		rationale: best.rationale
	};
}

/**
 * Finds the best concrete landmark click with a cheap, local approximation of
 * expected information gain. A candidate shared by multiple holes is useful;
 * a unique, already-clear candidate is not. The score is a ranking signal,
 * not calibrated confidence.
 */
export function recommendNextAnchor(
	map: ActiveReviewMap,
	options: ActiveReviewOptions = {}
): ActiveReviewRecommendation {
	const now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
	const start = now();
	const deadlineMs = Math.max(1, options.deadlineMs ?? DEFAULT_DEADLINE_MS);
	const deadline = start + deadlineMs;
	const minAutoSuggestScore = clamp01(options.minAutoSuggestScore ?? DEFAULT_MIN_AUTO_SUGGEST_SCORE);
	const confirmedCandidates = confirmedCandidateSet(map);
	const stats = candidateStats(map);
	let best:
		| { candidate: ActiveReviewCandidate; holeNumber: number; score: number; rationale: ActiveReviewRationale }
		| null = null;

	for (const candidate of map.candidates) {
		const candidateStat = stats.get(candidate.id);
		if (!candidateStat || confirmedCandidates.has(candidate.id)) continue;
		for (const link of candidateStat.links) {
			if (now() >= deadline) {
				if (best) return recommendationFromBest(best, minAutoSuggestScore, true);
				return noneRecommendation(true, 'deadline');
			}
			const hole = map.holes.find((entry) => entry.number === link.holeNumber);
			if (!hole) continue;
			const competingHoleCount = Math.max(0, candidateStat.links.length - 1);
			const isMissingTarget = hole.missing.includes(candidate.kind);
			if (competingHoleCount === 0 && !isMissingTarget) continue;
			const targetUncertainty = clamp01(1 - hole.confidence);
			const targetNeed = hole.status === 'incomplete' ? 1.35 : hole.status === 'review' ? 1.15 : 0.85;
			const detectorQuality = 0.75 + candidateScore(candidate) * 0.25;
			const rawScore =
				candidateStat.uncertainty * (1 + competingHoleCount) * associationScore(link.score) *
					detectorQuality * (0.8 + targetUncertainty * 0.7) * targetNeed +
				(isMissingTarget ? 0.35 : 0);
			const usefulnessScore = clamp01(rawScore / (rawScore + 1));
			const rationale: ActiveReviewRationale = {
				affectedAssociationCount: candidateStat.links.length,
				competingHoleCount,
				ambiguity: candidateStat.uncertainty,
				missingTee: isMissingTarget && candidate.kind === 'tee',
				targetConfidence: hole.confidence,
				targetStatus: hole.status
			};
			if (
				(!best || usefulnessScore > best.score || (usefulnessScore === best.score && link.holeNumber < best.holeNumber))
			) {
				best = { candidate, holeNumber: link.holeNumber, score: usefulnessScore, rationale };
			}
		}
	}

	if (best) return recommendationFromBest(best, minAutoSuggestScore, false);

	const fallbackHole = map.holes
		.filter((hole) => hole.missing.length > 0 && hole.anchor)
		.slice()
		.sort((left, right) => {
			const need = (hole: ActiveReviewHole): number =>
				hole.status === 'incomplete' ? 2 + (1 - hole.confidence) : hole.status === 'review' ? 1 + (1 - hole.confidence) : 1 - hole.confidence;
			return need(right) - need(left);
		})[0];
	const fallbackCandidate = fallbackHole
		? map.candidates
				.filter(
					(candidate) =>
						!confirmedCandidates.has(candidate.id) &&
						fallbackHole.missing.includes(candidate.kind) &&
						pointDistance(fallbackHole.anchor!, candidate) <= MAX_ACTIVE_REVIEW_LINK_RADIUS_PX
				)
				.sort((left, right) => candidateScore(right) - candidateScore(left))[0]
		: undefined;
	if (!fallbackCandidate || !fallbackHole) return noneRecommendation(false, 'no-useful-candidate');
	return recommendationFromBest(
		{
			candidate: fallbackCandidate,
			holeNumber: fallbackHole.number,
			score: 0,
			rationale: {
				affectedAssociationCount: 0,
				competingHoleCount: 0,
				ambiguity: 0,
				missingTee: fallbackHole.missing.includes('tee'),
				targetConfidence: fallbackHole.confidence,
				targetStatus: fallbackHole.status
			}
		},
		minAutoSuggestScore,
		false
	);
}

function median(values: readonly number[]): number {
	if (values.length === 0) return 80;
	const sorted = values.slice().sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function candidateScore(candidate: { readonly score?: number }): number {
	return clamp01(candidate.score ?? 0.5);
}

/** Converts the shipped grammar output into the small graph used by the recommender. */
export function buildActiveReviewMap(
	detection: CourseDetectionResult,
	confirmedHoleNumbers: readonly number[] = [],
	confirmedCandidateIds: readonly string[] = []
): ActiveReviewMap {
	const candidates: ActiveReviewCandidate[] = [
		...detection.tees.map((candidate, index) => ({
			id: `tee:${index}`,
			kind: 'tee' as const,
			candidateIndex: index,
			xPx: candidate.xPx,
			yPx: candidate.yPx,
			orientationDeg: candidate.orientationDeg,
			score: candidateScore(candidate)
		})),
		...detection.baskets.map((candidate, index) => ({
			id: `basket:${index}`,
			kind: 'basket' as const,
			candidateIndex: index,
			xPx: candidate.xPx,
			yPx: candidate.yPx,
			score: candidateScore(candidate)
		}))
	];
	const assignedDistances = detection.grammar.holes.flatMap((hole) => [hole.tee?.distancePx, hole.basket?.distancePx])
		.filter((distance): distance is number => typeof distance === 'number' && Number.isFinite(distance) && distance > 0);
	const linkRadius = Math.min(
		MAX_ACTIVE_REVIEW_LINK_RADIUS_PX,
		Math.max(MIN_ACTIVE_REVIEW_LINK_RADIUS_PX, median(assignedDistances) * 2.25)
	);

	const holes: ActiveReviewHole[] = detection.grammar.holes.map((proposal) => {
		const anchor = proposal.numberBadge ?? proposal.tee ?? proposal.basket;
		const badgeAnchor = proposal.numberBadge ?? anchor;
		const missing: ActiveReviewLandmarkKind[] = [];
		if (!proposal.tee || proposal.failures.some((failure) => failure.kind === 'missing-tee')) missing.push('tee');
		if (!proposal.basket || proposal.failures.some((failure) => failure.kind === 'missing-basket')) missing.push('basket');
		const associations: ActiveReviewAssociation[] = [];
		const assigned = new Map<string, number>();
		if (proposal.tee) assigned.set(`tee:${proposal.tee.candidateIndex}`, proposal.tee.confidence);
		if (proposal.basket) assigned.set(`basket:${proposal.basket.candidateIndex}`, proposal.basket.confidence);
		for (const candidate of candidates) {
			if (candidate.kind === 'tee' && !proposal.tee && !missing.includes('tee')) continue;
			if (candidate.kind === 'basket' && !proposal.basket && !missing.includes('basket')) continue;
			const assignedScore = assigned.get(candidate.id);
			const associationAnchor = candidate.kind === 'tee' ? badgeAnchor : anchor;
			const distance = associationAnchor ? pointDistance(associationAnchor, candidate) : Number.POSITIVE_INFINITY;
			if (assignedScore !== undefined) {
				associations.push({
					candidateId: candidate.id,
					kind: candidate.kind,
					score: endpointAssociationScore(assignedScore, candidate, badgeAnchor)
				});
			} else if (distance <= linkRadius) {
				const proximity = Math.exp(-distance / Math.max(1, linkRadius * 0.55));
				associations.push({
					candidateId: candidate.id,
					kind: candidate.kind,
					score: endpointAssociationScore(proximity * candidate.score, candidate, badgeAnchor)
				});
			}
		}
		return {
			number: proposal.number,
			...(anchor ? { anchor: { xPx: anchor.xPx, yPx: anchor.yPx } } : {}),
			status: proposal.status,
			confidence: proposal.confidence,
			missing,
			associations
		};
	});

	// Preserve unassigned detector output in the review graph only when it is
	// locally plausible. A candidate hundreds of pixels away must remain
	// unassigned; attaching it to the nearest missing hole creates a false
	// suggestion that looks more authoritative than the detector evidence.
	const candidateIdsWithLinks = new Set(
		holes.flatMap((hole) => hole.associations.map((association) => association.candidateId))
	);
	const holesWithUnassignedCandidates = holes.map((hole) => ({
		...hole,
		associations: [...hole.associations]
	}));
	for (const candidate of candidates) {
		if (candidateIdsWithLinks.has(candidate.id)) continue;
		const target = holesWithUnassignedCandidates
			.filter((hole) => hole.missing.includes(candidate.kind))
			.sort((left, right) => {
				const leftDistance = left.anchor ? pointDistance(left.anchor, candidate) : Number.POSITIVE_INFINITY;
				const rightDistance = right.anchor ? pointDistance(right.anchor, candidate) : Number.POSITIVE_INFINITY;
				return leftDistance - rightDistance;
			})[0];
		if (!target) continue;
		const distance = target.anchor ? pointDistance(target.anchor, candidate) : linkRadius;
		if (distance > linkRadius) continue;
		target.associations.push({
			candidateId: candidate.id,
			kind: candidate.kind,
			score: Math.max(
				0.15,
				endpointAssociationScore(Math.exp(-distance / Math.max(1, linkRadius)) * candidate.score, candidate, target.anchor)
			)
		});
	}
	return { holes: holesWithUnassignedCandidates, candidates, confirmedHoleNumbers, confirmedCandidateIds };
}
