import { describe, expect, it } from 'vitest';
import { associateCourseGrammar } from '../../src/lib/autoAnnotation/courseGrammar';

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
});
