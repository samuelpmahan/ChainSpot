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
 * P1 localizes the bright interior of UDisc's basket sprite and reports its
 * bottom-most bright pixel. The semantic basket point used by course geometry
 * is the sprite tip / common C1-C2 center, which sits at the bottom of the
 * black outline instead. Native-pixel measurement on The Rec Hole 4 puts that
 * point 4px below the bright component (`1434 -> 1438.04`), independently
 * corroborated by joint C1/C2 circle fitting.
 *
 * Keep this correction at the display/domain boundary: P3-P6 ownership should
 * continue using the raw detector coordinate they were tuned against, while
 * user-visible annotation/corridor geometry gets the semantic point.
 */
export const BASKET_SPRITE_TIP_OFFSET_PX = 4;

/**
 * Adapts the pancake ownership outputs into the existing grammar/result shape
 * consumed by Annotate Course. This is a display adapter only: P5/P6 have
 * already completed their ownership decisions before this function runs.
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
				(
					assignment
				): assignment is typeof assignment & { readonly assignedBasketIndex: number } =>
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
		const basket = p6Assignment
			? rawMaskObjects.baskets[p6Assignment.assignedBasketIndex]
			: undefined;
		const holeFailures: CourseGrammarFailure[] = [];

		if (badgeEntry) {
			assignedBadgeIndexes.add(badgeEntry.candidateIndex);
		} else {
			holeFailures.push({
				kind: 'missing-number-badge',
				severity: 'error',
				holeNumber,
				message: `Hole ${holeNumber} has no P2-labeled number badge.`
			});
		}
		if (tee && p5Assignment) {
			assignedTeeIndexes.add(p5Assignment.teeIndex);
		} else {
			holeFailures.push({
				kind: 'missing-tee',
				severity: 'error',
				holeNumber,
				message: `Hole ${holeNumber} has no assigned P5 tee.`
			});
		}
		if (basket && p6Assignment) {
			assignedBasketIndexes.add(p6Assignment.assignedBasketIndex);
		} else {
			holeFailures.push({
				kind: 'missing-basket',
				severity: 'error',
				holeNumber,
				message: `Hole ${holeNumber} has no assigned P6 basket.`
			});
		}

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
		const teeAssignment = tee && p5Assignment
			? {
					candidateIndex: p5Assignment.teeIndex,
					xPx: tee.xPx,
					yPx: tee.yPx,
					detectorConfidence: 1,
					confidence: 1,
					distancePx: p5Assignment.assignedAxisErrorPx ?? 0
				}
			: undefined;
		const basketAssignment = basket && p6Assignment
			? {
					candidateIndex: p6Assignment.assignedBasketIndex,
					xPx: basket.xPx,
					yPx: basket.yPx + BASKET_SPRITE_TIP_OFFSET_PX,
					detectorConfidence: 1,
					confidence: 1,
					distancePx: 0,
					cost: 0
				}
			: undefined;

		failures.push(...holeFailures);
		const complete = holeFailures.length === 0;
		return {
			number: holeNumber,
			...(numberBadge ? { numberBadge } : {}),
			...(teeAssignment ? { tee: teeAssignment } : {}),
			...(basketAssignment ? { basket: basketAssignment } : {}),
			confidence: complete ? 1 : 0,
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
