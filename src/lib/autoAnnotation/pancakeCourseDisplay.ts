import type {
	CourseGrammarFailure,
	CourseGrammarResult,
	CourseHoleProposal
} from './courseGrammar';
import type { HoleNumberDetection } from './holeNumberDetection';
import type { P5SparseAssignmentResult } from './p5SparseAssignment';
import type { P6LowParBasketAssignmentResult } from './p6LowParBasketAssignment';
import type { RawObjectMaskResult } from './rawObjectMask';

const PANCAKE_HOLE_NUMBERS = Array.from({ length: 18 }, (_, index) => index + 1);

/**
 * Compatibility value consumed by Annotate Course's legacy `confidence >=
 * threshold` auto-apply branch. P5/P6 do NOT produce a normalized confidence;
 * their real scores are respectively axis-error cost and LowPar score. Never
 * report this value as detector confidence.
 */
export const PANCAKE_UI_ELIGIBILITY_SENTINEL = 1;

/**
 * Adapts Pancake ownership outputs into the older CourseGrammarResult shape
 * consumed by Annotate Course. P5/P6 have already made their ownership
 * decisions. Extra runtime-only funnel fields are intentionally structural:
 * they survive worker structured-clone, are consumed by diagnostics, and are
 * discarded by `acceptCandidate()` before domain state.
 */
export function buildPancakeDisplayGrammar(
	rawMaskObjects: RawObjectMaskResult,
	p2BadgeDetection: HoleNumberDetection,
	p5: P5SparseAssignmentResult,
	p6: P6LowParBasketAssignmentResult
): CourseGrammarResult {
	const p5ByHole = new Map(
		p5.assignments
			.filter((assignment) => assignment.status === 'assigned' && assignment.assignedHoleNumber !== null)
			.map((assignment) => [assignment.assignedHoleNumber, assignment])
	);
	const p6ByHole = new Map(
		p6.assignments
			.filter(
				(assignment): assignment is typeof assignment & { readonly assignedBasketIndex: number } =>
					(assignment.status === 'p4Locked' ||
						assignment.status === 'zeroBendLocked' ||
						assignment.status === 'lowParAssigned') &&
					assignment.assignedBasketIndex !== null
			)
			.map((assignment) => [assignment.holeNumber, assignment])
	);
	const badgeByHole = new Map(
		p2BadgeDetection.candidates.flatMap((candidate, candidateIndex) =>
			candidate.label === undefined
				? []
				: [[candidate.label, { candidate, candidateIndex }] as const]
		)
	);

	const failures: CourseGrammarFailure[] = [];
	const assignedBadgeIndexes = new Set<number>();
	const assignedTeeIndexes = new Set<number>();
	const assignedBasketIndexes = new Set<number>();
	const holes: CourseHoleProposal[] = PANCAKE_HOLE_NUMBERS.map((holeNumber) => {
		const p5Assignment = p5ByHole.get(holeNumber);
		const p6Assignment = p6ByHole.get(holeNumber);
		const badgeEntry = badgeByHole.get(holeNumber);
		const tee = p5Assignment ? rawMaskObjects.tees[p5Assignment.teeIndex] : undefined;
		const basket = p6Assignment ? rawMaskObjects.baskets[p6Assignment.assignedBasketIndex] : undefined;
		const holeFailures: CourseGrammarFailure[] = [];

		if (badgeEntry) assignedBadgeIndexes.add(badgeEntry.candidateIndex);
		else holeFailures.push({
			kind: 'missing-number-badge', severity: 'error', holeNumber,
			message: `Hole ${holeNumber} has no P2-labeled number badge.`
		});
		if (tee && p5Assignment) assignedTeeIndexes.add(p5Assignment.teeIndex);
		else holeFailures.push({
			kind: 'missing-tee', severity: 'error', holeNumber,
			message: `Hole ${holeNumber} has no assigned P5 tee.`
		});
		if (basket && p6Assignment) assignedBasketIndexes.add(p6Assignment.assignedBasketIndex);
		else holeFailures.push({
			kind: 'missing-basket', severity: 'error', holeNumber,
			message: `Hole ${holeNumber} has no assigned P6 basket.`
		});

		const badgeConfidence = badgeEntry?.candidate.glyphScore ?? badgeEntry?.candidate.score ?? 0;
		const numberBadge = badgeEntry
			? {
					candidateIndex: badgeEntry.candidateIndex,
					xPx: badgeEntry.candidate.xPx,
					yPx: badgeEntry.candidate.yPx,
					confidence: badgeConfidence,
					cost: 1 - badgeConfidence
				}
			: undefined;

		const p5Score = p5Assignment && typeof p5Assignment.assignedAxisErrorPx === 'number'
			? { name: 'p5.assignedAxisErrorPx' as const, value: p5Assignment.assignedAxisErrorPx, higherIsBetter: false as const }
			: undefined;
		const teeAssignment = tee && p5Assignment
			? {
					candidateIndex: p5Assignment.teeIndex,
					xPx: tee.xPx,
					yPx: tee.yPx,
					// Legacy UI compatibility only; see confidenceSemantics below.
					detectorConfidence: PANCAKE_UI_ELIGIBILITY_SENTINEL,
					confidence: PANCAKE_UI_ELIGIBILITY_SENTINEL,
					distancePx: p5Assignment.assignedAxisErrorPx ?? 0,
					landmarkKind: 'tee' as const,
					widthPx: tee.widthPx,
					heightPx: tee.heightPx,
					confidenceSemantics: 'ui-eligibility-sentinel' as const,
					...(p5Score ? { selectionScore: p5Score } : {})
				}
			: undefined;

		const p6Score = p6Assignment && typeof p6Assignment.lowParScore === 'number'
			? { name: 'p6.lowParScore' as const, value: p6Assignment.lowParScore, higherIsBetter: true as const }
			: undefined;
		const basketAssignment = basket && p6Assignment
			? {
					candidateIndex: p6Assignment.assignedBasketIndex,
					xPx: basket.xPx,
					yPx: basket.yPx,
					// Legacy UI compatibility only; see confidenceSemantics below.
					detectorConfidence: PANCAKE_UI_ELIGIBILITY_SENTINEL,
					confidence: PANCAKE_UI_ELIGIBILITY_SENTINEL,
					distancePx: 0,
					cost: 0,
					landmarkKind: 'basket' as const,
					widthPx: basket.widthPx,
					heightPx: basket.heightPx,
					confidenceSemantics: 'ui-eligibility-sentinel' as const,
					...(p6Score ? { selectionScore: p6Score } : {})
				}
			: undefined;

		failures.push(...holeFailures);
		const complete = holeFailures.length === 0;
		return {
			number: holeNumber,
			...(numberBadge ? { numberBadge } : {}),
			...(teeAssignment ? { tee: teeAssignment } : {}),
			...(basketAssignment ? { basket: basketAssignment } : {}),
			// Compatibility readiness sentinel, not a calibrated pipeline score.
			confidence: complete ? PANCAKE_UI_ELIGIBILITY_SENTINEL : 0,
			status: complete ? 'ready' : 'incomplete',
			failures: holeFailures
		};
	});

	return {
		holes,
		failures,
		unassigned: {
			numberBadgeCandidateIndexes: p2BadgeDetection.candidates
				.map((_, index) => index)
				.filter((index) => !assignedBadgeIndexes.has(index)),
			teeCandidateIndexes: rawMaskObjects.tees
				.map((_, index) => index)
				.filter((index) => !assignedTeeIndexes.has(index)),
			basketCandidateIndexes: rawMaskObjects.baskets
				.map((_, index) => index)
				.filter((index) => !assignedBasketIndexes.has(index))
		}
	};
}
