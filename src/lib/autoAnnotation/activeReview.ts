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
	readonly confirmedCandidateIds?: readonly string[];
}

/**
 * Whether a hole's tee/basket is actually placed right now, in the live
 * annotation draft -- as opposed to whether the one-time detection pass
 * originally proposed something for it. `buildActiveReviewMap` uses this,
 * not `CourseHoleProposal.tee`/`.basket` presence, to decide `missing`: a
 * hole whose only assignment was weak and has since been rejected (or
 * never had one at all) must keep reading as unresolved for as long as
 * nothing is actually placed, matching a "N holes need review" style count
 * -- not silently drop out of the guided queue once its local candidate
 * pool runs out. As of this module, no live session actually supplies this
 * (see `livePlacementsFromGrammar`'s doc comment) -- CLI/benchmark callers
 * are the only current consumers.
 */
export interface ActiveReviewLivePlacement {
	readonly tee: boolean;
	readonly basket: boolean;
}

/**
 * Stable key for a hole/landmark pair, used to track "wrong guess" counts
 * (rejected or replaced recommendations) across recomputes, so a caller that
 * records rejections and `buildActiveReviewMap` (which consumes the
 * resulting exhausted set) agree on the format. No current caller does both
 * halves of this -- see `livePlacementsFromGrammar`'s doc comment.
 */
export function exhaustedLandmarkKey(holeNumber: number, kind: ActiveReviewLandmarkKind): string {
	return `${holeNumber}:${kind}`;
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
			/** Set only for 'needs-manual-placement': the orphaned hole this points at. */
			readonly holeNumber?: number;
			/**
			 * 0 for 'deadline'/'no-useful-candidate' (nothing anywhere is useful).
			 * For 'needs-manual-placement' this reflects the target's own need, so an
			 * orphaned hole still ranks near the top of a caller's review queue
			 * instead of silently reporting the same score as "nothing to do".
			 */
			readonly score: number;
			readonly timedOut: boolean;
			readonly reason: 'deadline' | 'no-useful-candidate' | 'needs-manual-placement';
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

/** How badly a hole needs attention, independent of whether any candidate can fill it. */
function holeNeed(hole: ActiveReviewHole): number {
	return hole.status === 'incomplete'
		? 2 + (1 - hole.confidence)
		: hole.status === 'review'
			? 1 + (1 - hole.confidence)
			: 1 - hole.confidence;
}

/**
 * A hole is "orphaned" for a missing landmark kind when zero unconfirmed
 * candidates survived into its association list for that kind — i.e. nothing
 * is close enough, or plausible enough, to ever be offered as a `'candidate'`
 * pick for it. The main scoring loop below only ever considers candidate ->
 * hole links, so an orphaned hole never enters that competition and would
 * otherwise silently drop out of the review queue for as long as any other
 * hole still has a real candidate to suggest. Surfacing it here, scored by
 * its own need rather than a hardcoded 0, keeps it ranked at/near the top
 * instead of invisible.
 */
function orphanedHoleRecommendation(
	map: ActiveReviewMap,
	confirmedCandidates: ReadonlySet<string>
): ActiveReviewRecommendation | undefined {
	const orphaned = map.holes
		.filter((hole) =>
			hole.missing.some(
				(kind) => !hole.associations.some((association) => association.kind === kind && !confirmedCandidates.has(association.candidateId))
			)
		)
		.slice()
		.sort((left, right) => holeNeed(right) - holeNeed(left))[0];
	if (!orphaned) return undefined;
	const rawScore = holeNeed(orphaned);
	return {
		kind: 'none',
		holeNumber: orphaned.number,
		score: clamp01(rawScore / (rawScore + 1)),
		timedOut: false,
		reason: 'needs-manual-placement',
		rationale: {
			affectedAssociationCount: 0,
			competingHoleCount: 0,
			ambiguity: 1,
			missingTee: orphaned.missing.includes('tee'),
			targetConfidence: orphaned.confidence,
			targetStatus: orphaned.status
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

	if (best) {
		// An orphaned hole (zero surviving candidates for a landmark it's
		// missing) never appears in the loop above, since that loop only ever
		// iterates candidate -> hole links. Without this check it would rank
		// behind even a barely-useful suggestion for some unrelated,
		// already-better-off hole, for as long as any such suggestion exists
		// anywhere on the map. Compare on the same 0..1 scale so a severely
		// orphaned hole (e.g. 'incomplete') can still outrank a weak match.
		const orphan = orphanedHoleRecommendation(map, confirmedCandidates);
		if (orphan && orphan.score > best.score) return orphan;
		return recommendationFromBest(best, minAutoSuggestScore, false);
	}

	const fallbackHole = map.holes
		.filter((hole) => hole.missing.length > 0 && hole.anchor)
		.slice()
		.sort((left, right) => holeNeed(right) - holeNeed(left))[0];
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
	if (!fallbackCandidate || !fallbackHole) {
		// Nothing at all, or nothing within the broad fallback radius. If some
		// hole is orphaned (zero candidates for a kind it's missing), say so
		// explicitly with a need-scaled score instead of collapsing it into the
		// same 0-score "nothing to do" reason as a genuinely empty queue.
		const orphan = orphanedHoleRecommendation(map, confirmedCandidates);
		if (orphan) return orphan;
		return noneRecommendation(false, 'no-useful-candidate');
	}
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

/**
 * A `livePlacements` map for callers with no live annotation session at all
 * (the CLI preview, benchmarks) -- treats the one-time detection's own
 * proposal presence as "placed", exactly `buildActiveReviewMap`'s pre-live-
 * state behavior. Do not use this as a stand-in for a real live session: a
 * caller with an actual annotation draft must build its map from that
 * draft's real `holes[]`, not from the frozen detection snapshot this
 * reconstructs. Note the redesigned Annotate Round page (`+page.svelte`)
 * does not currently call `buildActiveReviewMap` at all -- it tracks its own
 * "N holes need review" count independently -- so today this module's only
 * callers are CLI/benchmark tooling (`scripts/detect-course.ts`,
 * `scripts/verify-course-detection.ts`, `scripts/benchmark-active-review.ts`).
 */
export function livePlacementsFromGrammar(
	detection: CourseDetectionResult
): ReadonlyMap<number, ActiveReviewLivePlacement> {
	return new Map(
		detection.grammar.holes.map((proposal) => [
			proposal.number,
			{ tee: proposal.tee !== undefined, basket: proposal.basket !== undefined }
		])
	);
}

/** Converts the shipped grammar output into the small graph used by the recommender. */
export function buildActiveReviewMap(
	detection: CourseDetectionResult,
	livePlacements: ReadonlyMap<number, ActiveReviewLivePlacement> = new Map(),
	confirmedCandidateIds: readonly string[] = [],
	/**
	 * Hole/landmark pairs (`exhaustedLandmarkKey`) the caller has decided to
	 * stop auto-suggesting for -- after enough rejected/replaced guesses, a
	 * real tee/basket pad may simply not be visible in the source image, and
	 * continuing to offer candidates for it is worse than just asking the
	 * user to place it directly. Treated as if zero candidates exist for
	 * that hole/kind, which routes it through the same "needs manual
	 * placement" path an already-orphaned hole takes.
	 */
	exhaustedLandmarks: ReadonlySet<string> = new Set()
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
		// Live placement state, not the one-time proposal's own tee/basket
		// presence, decides `missing` -- see `ActiveReviewLivePlacement`'s doc
		// comment. A hole whose only detected assignment was weak and has
		// since been rejected must keep reading as unresolved, not silently
		// stop being `missing` just because a (rejected) proposal once existed.
		const live = livePlacements.get(proposal.number);
		const teePlaced = live?.tee ?? false;
		const basketPlaced = live?.basket ?? false;
		const teeExhausted = exhaustedLandmarks.has(exhaustedLandmarkKey(proposal.number, 'tee'));
		const basketExhausted = exhaustedLandmarks.has(exhaustedLandmarkKey(proposal.number, 'basket'));
		const missing: ActiveReviewLandmarkKind[] = [];
		if (!teePlaced) missing.push('tee');
		if (!basketPlaced) missing.push('basket');
		const associations: ActiveReviewAssociation[] = [];
		const assigned = new Map<string, number>();
		if (proposal.tee) assigned.set(`tee:${proposal.tee.candidateIndex}`, proposal.tee.confidence);
		if (proposal.basket) assigned.set(`basket:${proposal.basket.candidateIndex}`, proposal.basket.confidence);
		for (const candidate of candidates) {
			// Once a landmark is actually placed, this hole is done for that
			// kind -- never keep offering alternatives for it, regardless of
			// what the original detection proposed (see doc comment above).
			if (candidate.kind === 'tee' && teePlaced) continue;
			if (candidate.kind === 'basket' && basketPlaced) continue;
			// Two wrong guesses in a row and we stop guessing: treat this
			// hole/kind as if no candidate exists at all, which routes it
			// through the orphaned-hole "needs manual placement" path instead
			// of a third automatic suggestion.
			if (candidate.kind === 'tee' && teeExhausted) continue;
			if (candidate.kind === 'basket' && basketExhausted) continue;
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
			// An exhausted hole/kind must stay unassigned here too, or this pass
			// undoes the skip above by re-attaching a stray nearby candidate.
			.filter(
				(hole) =>
					hole.missing.includes(candidate.kind) &&
					!exhaustedLandmarks.has(exhaustedLandmarkKey(hole.number, candidate.kind))
			)
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
	return { holes: holesWithUnassignedCandidates, candidates, confirmedCandidateIds };
}
