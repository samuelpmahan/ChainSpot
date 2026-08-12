import { describe, expect, it } from 'vitest';
import { associateCourseGrammar } from '../../src/lib/autoAnnotation/courseGrammar';

describe('course grammar with occlusion-fallback basket ownership', () => {
	it('caps a REVIEW-tier fallback basket below AUTO/ready confidence even with clean topology', () => {
		const result = associateCourseGrammar({
			holeNumbers: [1],
			numberBadges: [{ xPx: 100, yPx: 100, score: 1, holeNumber: 1 }],
			tees: [{ xPx: 40, yPx: 100, score: 1, confidence: 0.95, holeNumber: 1, bootstrapDecision: 'auto' }],
			// Ideal topology (opposite ray from the tee, through the badge) and a
			// high raw detector score -- without the REVIEW cap this would clear
			// the 0.7 'ready' bar on geometry alone.
			baskets: [{ xPx: 160, yPx: 100, score: 0.95, bootstrapDecision: 'review' }]
		});

		const hole = result.holes[0];
		expect(hole.basket?.xPx).toBe(160);
		expect(hole.basket!.confidence).toBeLessThan(0.5);
		expect(hole.status).not.toBe('ready');
		expect(hole.failures.some((failure) =>
			failure.kind === 'weak-basket-confidence' &&
			failure.message.includes('occlusion-fallback REVIEW proposal')
		)).toBe(true);
	});

	it('leaves an ordinary primary-detection basket unaffected (no bootstrapDecision => scored exactly as before)', () => {
		const result = associateCourseGrammar({
			holeNumbers: [1],
			numberBadges: [{ xPx: 100, yPx: 100, score: 1, holeNumber: 1 }],
			tees: [{ xPx: 40, yPx: 100, score: 1, confidence: 0.95, holeNumber: 1, bootstrapDecision: 'auto' }],
			baskets: [{ xPx: 160, yPx: 100, score: 0.95 }]
		});

		const hole = result.holes[0];
		expect(hole.basket?.xPx).toBe(160);
		expect(hole.status).toBe('ready');
		expect(hole.failures.some((failure) => failure.kind === 'weak-basket-confidence')).toBe(false);
	});
});
