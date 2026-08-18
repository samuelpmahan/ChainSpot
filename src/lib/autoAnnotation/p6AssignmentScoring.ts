/**
 * Correctness scorer for a P6 basket-assignment result against externally
 * supplied ground truth. This is a pure comparison utility: it never touches
 * the pipeline, and truth loading/format-specific parsing (project.json
 * `holes[]`, or a `the-rec.json`-style fixture) is the caller's job.
 */

import type { RawMaskBasket } from './rawObjectMask';
import type { P6LowParBasketAssignmentResult } from './p6LowParBasketAssignment';

/** Matches the repo-wide ground-truth tolerance convention (see scripts/benchmark-course-corpus.ts): `GROUND_TRUTH_TOLERANCE_FACTOR * uiScalePx`. */
export const GROUND_TRUTH_TOLERANCE_FACTOR = 7;
/** Fallback absolute tolerance (px) when no `uiScalePx` is available to derive one from. */
export const DEFAULT_TOLERANCE_PX = 40;

export interface TruthHole {
	readonly number: number;
	readonly basket: { readonly xPx: number; readonly yPx: number };
}

export interface ScoredHole {
	readonly holeNumber: number;
	readonly assignedBasketIndex: number | null;
	readonly errorPx: number | null;
	readonly withinTolerance: boolean;
}

export interface P6AssignmentScore {
	readonly scoredHoles: number;
	readonly correct: number;
	readonly incorrect: readonly { readonly holeNumber: number; readonly errorPx: number }[];
	readonly unresolved: number;
	readonly meanErrorPx: number | null;
	readonly tolerancePx: number;
	readonly details: readonly ScoredHole[];
}

/**
 * Scores an assigned-basket position against ground truth per hole, within
 * `tolerancePx`. A hole with no assignment (unresolved/no truth match) is
 * counted in `unresolved`, not `incorrect` -- "incorrect" specifically means
 * "assigned, but to the wrong place".
 */
export function score(
	p6Result: Pick<P6LowParBasketAssignmentResult, 'assignments'>,
	baskets: readonly Pick<RawMaskBasket, 'centerXPx' | 'centerYPx'>[],
	truthHoles: readonly TruthHole[],
	tolerancePx: number = DEFAULT_TOLERANCE_PX
): P6AssignmentScore {
	const truthByHole = new Map(truthHoles.map((hole) => [hole.number, hole]));
	const assignmentByHole = new Map(p6Result.assignments.map((assignment) => [assignment.holeNumber, assignment]));

	const details: ScoredHole[] = [];
	for (const truth of truthHoles) {
		const assignment = assignmentByHole.get(truth.number);
		const basketIndex = assignment?.assignedBasketIndex ?? null;
		if (basketIndex === null || basketIndex < 0 || basketIndex >= baskets.length) {
			details.push({
				holeNumber: truth.number,
				assignedBasketIndex: basketIndex,
				errorPx: null,
				withinTolerance: false
			});
			continue;
		}
		const basket = baskets[basketIndex];
		const errorPx = Math.hypot(basket.centerXPx - truth.basket.xPx, basket.centerYPx - truth.basket.yPx);
		details.push({
			holeNumber: truth.number,
			assignedBasketIndex: basketIndex,
			errorPx,
			withinTolerance: errorPx <= tolerancePx
		});
	}

	const unresolved = details.filter((detail) => detail.errorPx === null).length;
	const correct = details.filter((detail) => detail.withinTolerance).length;
	const incorrect = details
		.filter((detail): detail is ScoredHole & { errorPx: number } => detail.errorPx !== null && !detail.withinTolerance)
		.map((detail) => ({ holeNumber: detail.holeNumber, errorPx: detail.errorPx }));
	const measuredErrors = details.filter((detail): detail is ScoredHole & { errorPx: number } => detail.errorPx !== null);
	const meanErrorPx =
		measuredErrors.length > 0
			? measuredErrors.reduce((total, detail) => total + detail.errorPx, 0) / measuredErrors.length
			: null;

	return {
		scoredHoles: truthByHole.size,
		correct,
		incorrect,
		unresolved,
		meanErrorPx,
		tolerancePx,
		details
	};
}
