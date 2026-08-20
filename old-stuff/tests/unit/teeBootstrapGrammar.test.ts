import { describe, expect, it } from 'vitest';
import { associateCourseGrammar } from '../../src/lib/autoAnnotation/courseGrammar';

describe('course grammar with tee bootstrap ownership', () => {
	it('never reassigns an explicitly owned tee to a different hole', () => {
		const result = associateCourseGrammar({
			holeNumbers: [1, 2],
			numberBadges: [
				{ xPx: 100, yPx: 100, score: 1, holeNumber: 1 },
				{ xPx: 200, yPx: 100, score: 1, holeNumber: 2 }
			],
			tees: [
				// Deliberately put each tee closer to the OTHER badge. Explicit
				// bootstrap ownership must beat distance/Hungarian pressure.
				{ xPx: 185, yPx: 100, score: 1, confidence: 0.95, holeNumber: 1, bootstrapDecision: 'auto' },
				{ xPx: 115, yPx: 100, score: 1, confidence: 0.95, holeNumber: 2, bootstrapDecision: 'auto' }
			],
			baskets: [
				{ xPx: 70, yPx: 100, score: 1 },
				{ xPx: 230, yPx: 100, score: 1 }
			]
		});

		expect(result.holes.find((hole) => hole.number === 1)?.tee?.xPx).toBe(185);
		expect(result.holes.find((hole) => hole.number === 2)?.tee?.xPx).toBe(115);
	});

	it('keeps REVIEW tee proposals reviewable instead of silently promoting them', () => {
		const result = associateCourseGrammar({
			holeNumbers: [5],
			numberBadges: [{ xPx: 100, yPx: 100, score: 1, holeNumber: 5 }],
			tees: [{
				xPx: 60,
				yPx: 100,
				score: 1,
				confidence: 0.49,
				holeNumber: 5,
				bootstrapDecision: 'review'
			}],
			baskets: [{ xPx: 140, yPx: 100, score: 1 }]
		});

		const hole = result.holes[0];
		expect(hole.status).toBe('review');
		expect(hole.tee?.confidence).toBeLessThan(0.5);
		expect(hole.failures.some((failure) => failure.kind === 'weak-tee-confidence')).toBe(true);
	});
});
