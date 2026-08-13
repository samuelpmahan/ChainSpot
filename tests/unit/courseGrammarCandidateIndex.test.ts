import { describe, expect, it } from 'vitest';
import { associateCourseGrammar, deriveBasketPolarityPenaltyPx } from '../../src/lib/autoAnnotation/courseGrammar';

describe('course grammar candidateIndex passthrough', () => {
	it('reports the explicit candidateIndex, not array position, when the caller passes a compacted/reordered array', () => {
		// Mirrors basketDetection.worker.ts's real shape: `grammarTees` is
		// `teeBootstrap.assignments` (one entry per resolved hole, in whatever
		// order assignment happened), not positionally aligned with the raw
		// `teeBootstrap.candidates` array. Position 0 here is hole 2's tee
		// (its real raw index is 7); position 1 is hole 1's tee (raw index 3).
		const result = associateCourseGrammar({
			holeNumbers: [1, 2],
			numberBadges: [
				{ xPx: 100, yPx: 100, score: 1, holeNumber: 1 },
				{ xPx: 300, yPx: 100, score: 1, holeNumber: 2 }
			],
			tees: [
				{ xPx: 340, yPx: 100, score: 1, confidence: 0.9, holeNumber: 2, bootstrapDecision: 'auto', candidateIndex: 7 },
				{ xPx: 60, yPx: 100, score: 1, confidence: 0.9, holeNumber: 1, bootstrapDecision: 'auto', candidateIndex: 3 }
			],
			baskets: []
		});

		const hole1 = result.holes.find((hole) => hole.number === 1);
		const hole2 = result.holes.find((hole) => hole.number === 2);
		expect(hole1?.tee).toMatchObject({ candidateIndex: 3, xPx: 60 });
		expect(hole2?.tee).toMatchObject({ candidateIndex: 7, xPx: 340 });
	});

	it('falls back to array position when candidateIndex is not supplied (unchanged behavior for badges/baskets today)', () => {
		const result = associateCourseGrammar({
			holeNumbers: [1],
			numberBadges: [{ xPx: 100, yPx: 100, score: 1, holeNumber: 1 }],
			tees: [{ xPx: 40, yPx: 100, score: 1, confidence: 0.95, holeNumber: 1, bootstrapDecision: 'auto' }],
			baskets: [{ xPx: 160, yPx: 100, score: 0.95 }]
		});

		const hole = result.holes[0];
		expect(hole.tee?.candidateIndex).toBe(0);
		expect(hole.basket?.candidateIndex).toBe(0);
	});

	it('lets AUTO tees reserve baskets before REVIEW holes solve remaining distance ownership', () => {
		const numberBadges = [
			{ xPx: 1360, yPx: 988, score: 1, holeNumber: 1 },
			{ xPx: 1020, yPx: 1242, score: 1, holeNumber: 2 },
			{ xPx: 1076, yPx: 1409, score: 1, holeNumber: 3 },
			{ xPx: 3000, yPx: 500, score: 1, holeNumber: 4 },
			{ xPx: 3000, yPx: 1500, score: 1, holeNumber: 5 },
			{ xPx: 3000, yPx: 2500, score: 1, holeNumber: 6 }
		];
		const baskets = [
			{ xPx: 902, yPx: 943, score: 0.9 },
			{ xPx: 1377, yPx: 1204, score: 0.9 },
			{ xPx: 855, yPx: 1330, score: 0.9 },
			{ xPx: 2750, yPx: 500, score: 0.9 },
			{ xPx: 2700, yPx: 1500, score: 0.9 },
			{ xPx: 2650, yPx: 2500, score: 0.9 }
		];
		const result = associateCourseGrammar({
			holeNumbers: [1, 2, 3, 4, 5, 6],
			numberBadges,
			tees: [
				{ xPx: 1605, yPx: 945, score: 0.95, holeNumber: 1, bootstrapDecision: 'auto' },
				{ xPx: 1308, yPx: 974, score: 0.3, holeNumber: 2, bootstrapDecision: 'review' },
				{ xPx: 1321, yPx: 1496, score: 0.45, holeNumber: 3, bootstrapDecision: 'review' },
				{ xPx: 3250, yPx: 500, score: 0.95, holeNumber: 4, bootstrapDecision: 'auto' },
				{ xPx: 3300, yPx: 1500, score: 0.95, holeNumber: 5, bootstrapDecision: 'auto' },
				{ xPx: 3350, yPx: 2500, score: 0.95, holeNumber: 6, bootstrapDecision: 'auto' }
			],
			baskets,
			basketPolarityPenaltyPx: 450
		});
		expect(result.holes.map((hole) => hole.basket?.candidateIndex)).toEqual([0, 1, 2, 3, 4, 5]);
		expect(result.unassigned.basketCandidateIndexes).toEqual([]);
	});

	it('derives a capture-scale-relative polarity penalty', () => {
		const badges = [{ xPx: 0, yPx: 0 }, { xPx: 100, yPx: 0 }];
		const baskets = [{ xPx: 20, yPx: 0 }, { xPx: 140, yPx: 0 }];
		const base = deriveBasketPolarityPenaltyPx(badges, baskets);
		const scaled = deriveBasketPolarityPenaltyPx(
			badges.map((point) => ({ xPx: point.xPx * 2, yPx: point.yPx * 2 })),
			baskets.map((point) => ({ xPx: point.xPx * 2, yPx: point.yPx * 2 }))
		);
		expect(scaled).toBeCloseTo(base * 2);
	});
});
