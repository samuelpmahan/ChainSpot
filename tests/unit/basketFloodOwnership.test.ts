import { describe, expect, it } from 'vitest';
import { findExclusiveBasketFloodOwnership } from '../../src/lib/autoAnnotation/basketFloodOwnership';
import { associateCourseGrammar } from '../../src/lib/autoAnnotation/courseGrammar';

function segmentation(rows: readonly (readonly number[])[]) {
	const heightEv = rows.length;
	const widthEv = rows[0]?.length ?? 0;
	return {
		labels: Int32Array.from(rows.flat()),
		widthEv,
		heightEv,
		scale: 1
	};
}

describe('basket flood-fill ownership', () => {
	it('locks only a component with exactly one badge and one basket', () => {
		const result = findExclusiveBasketFloodOwnership(
			segmentation([
				[1, 1, 0, 2, 2],
				[1, 1, 0, 2, 2],
				[0, 0, 0, 0, 0]
			]),
			[
				{ holeNumber: 1, xPx: 0, yPx: 0 },
				{ holeNumber: 2, xPx: 3, yPx: 0 },
				{ holeNumber: 3, xPx: 4, yPx: 0 }
			],
			[
				{ xPx: 1, yPx: 1 },
				{ xPx: 3, yPx: 1 }
			],
			0
		);
		expect(result.locks).toEqual([{ holeNumber: 1, basketCandidateIndex: 0, componentLabel: 1 }]);
		expect(result.ambiguousComponents).toEqual([
			{ componentLabel: 2, holeNumbers: [2, 3], basketCandidateIndexes: [1] }
		]);
	});

	it('does not lock multiple basket candidates on one otherwise-exclusive component', () => {
		const result = findExclusiveBasketFloodOwnership(
			segmentation([[1, 1, 1, 1]]),
			[{ holeNumber: 7, xPx: 0, yPx: 0 }],
			[{ xPx: 1, yPx: 0 }, { xPx: 3, yPx: 0 }],
			0
		);
		expect(result.locks).toHaveLength(0);
		expect(result.ambiguousComponents[0]).toMatchObject({
			holeNumbers: [7],
			basketCandidateIndexes: [0, 1]
		});
	});

	it('reserves a structurally-owned basket inside the full global grammar', () => {
		const result = associateCourseGrammar({
			holeNumbers: [1, 2],
			numberBadges: [
				{ xPx: 0, yPx: 0, confidence: 1, holeNumber: 1 },
				{ xPx: 100, yPx: 0, confidence: 1, holeNumber: 2 }
			],
			tees: [
				{ xPx: -20, yPx: 0, confidence: 1, holeNumber: 1, bootstrapDecision: 'auto' as const },
				{ xPx: 120, yPx: 0, confidence: 1, holeNumber: 2, bootstrapDecision: 'auto' as const }
			],
			// Candidate 0 is intentionally much closer to hole 2's badge, but its
			// exclusive ribbon component has already established hole 1 as owner.
			baskets: [
				{ xPx: 90, yPx: 0, confidence: 1, lockedHoleNumber: 1 },
				{ xPx: 40, yPx: 0, confidence: 1 }
			],
			basketPolarityPenaltyPx: 0
		});
		expect(result.holes.find((hole) => hole.number === 1)?.basket?.candidateIndex).toBe(0);
		expect(result.holes.find((hole) => hole.number === 2)?.basket?.candidateIndex).toBe(1);
	});
});