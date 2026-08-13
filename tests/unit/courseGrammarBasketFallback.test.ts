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

	// Regression: `OccludedBasketCandidate` (cvCalibratedDetectors.ts) already
	// carries `holeNumber` -- the hole its masked search was centered on, pure
	// provenance -- and `basketDetection.worker.ts`/`detect-course.ts` splice
	// `bootstrapDecision: 'review'` onto that same object before handing it to
	// `associateCourseGrammar`. That object shape must never be read as an
	// explicit ownership lock (`CourseBasketCandidate.lockedHoleNumber`):
	// doing so would silently force a hole onto its weak, masked-correlation
	// fallback match even when a much better, ordinary primary-detection
	// basket is sitting right there unclaimed.
	it('does not let an occlusion-fallback candidate\'s provenance `holeNumber` act as a hard ownership lock', () => {
		// Built via a plain variable rather than an inline object literal, like
		// `nonDuplicateRecovered.map((candidate) => ({ ...candidate, bootstrapDecision: 'review' }))`
		// actually produces in basketDetection.worker.ts/detect-course.ts: an
		// `OccludedBasketCandidate`-shaped value carrying `holeNumber` (the hole
		// its masked search was centered on -- provenance, not ownership) plus
		// `bootstrapDecision: 'review'`, but no `lockedHoleNumber`. Farther from
		// hole 1's badge than the ordinary primary candidate below.
		const occlusionFallbackShapedCandidate = {
			xPx: 200,
			yPx: 0,
			confidence: 1,
			holeNumber: 1,
			bootstrapDecision: 'review' as const
		};
		const result = associateCourseGrammar({
			holeNumbers: [1, 2],
			basketPolarityPenaltyPx: 0,
			numberBadges: [
				{ xPx: 0, yPx: 0, confidence: 1, holeNumber: 1 },
				{ xPx: 500, yPx: 0, confidence: 1, holeNumber: 2 }
			],
			tees: [
				{ xPx: -20, yPx: 0, confidence: 1, holeNumber: 1, bootstrapDecision: 'auto' as const },
				{ xPx: 480, yPx: 0, confidence: 1, holeNumber: 2, bootstrapDecision: 'auto' as const }
			],
			baskets: [
				occlusionFallbackShapedCandidate,
				// An ordinary, unowned, much closer primary-detection basket for hole 1.
				{ xPx: 10, yPx: 0, confidence: 1 },
				// Hole 2's own basket, far away and unambiguous.
				{ xPx: 600, yPx: 0, confidence: 1 }
			]
		});

		const hole1 = result.holes.find((hole) => hole.number === 1);
		const hole2 = result.holes.find((hole) => hole.number === 2);
		expect(hole1?.basket?.xPx).toBe(10);
		expect(hole2?.basket?.xPx).toBe(600);
	});
});

describe('course grammar Stage 4 basket ownership for a tee-less hole', () => {
	// Regression for the TowneLake-RedTees-b case: hole 5's tee bootstrap found
	// zero usable candidates (`missing-tee`). Excluding hole 5 from Stage 4's
	// Hungarian pool entirely (the old bug) left its own basket, 94px from its
	// own badge, completely unclaimed and available for hole 2 to win instead
	// -- even though hole 2's badge sits farther (~106px) from that basket than
	// hole 5's badge does. A tee-less hole must still compete in Stage 4, on
	// distance-only cost, so its rightful basket cannot be handed away for
	// free to a neighboring hole that merely has a working tee.
	it('keeps a missing-tee hole in the Stage 4 pool so a neighboring hole cannot win its basket for free', () => {
		const result = associateCourseGrammar({
			holeNumbers: [2, 5],
			// basketPolarityPenaltyPx: 0 isolates the bug to pure distance math --
			// the polarity term is orthogonal to this regression.
			basketPolarityPenaltyPx: 0,
			numberBadges: [
				{ xPx: 100, yPx: 100, score: 1, holeNumber: 5 },
				{ xPx: 150, yPx: 100, score: 1, holeNumber: 2 }
			],
			// Only hole 2 has a viable tee candidate; hole 5's bootstrap produced
			// none, so hole 5 must end up with a `missing-tee` failure.
			tees: [{ xPx: 200, yPx: 100, score: 1, confidence: 0.9, holeNumber: 2, bootstrapDecision: 'auto' }],
			baskets: [
				// Hole 5's true basket: 94px straight up from its own badge.
				{ xPx: 100, yPx: 6, score: 0.95 },
				// Hole 2's true basket: 110px straight down from its own badge --
				// farther from hole 2's badge (110px) than hole 5's basket is from
				// hole 2's badge (~106.5px), which is what let hole 2 "win" it
				// under the old per-row-greedy exclusion bug.
				{ xPx: 150, yPx: 210, score: 0.95 }
			]
		});

		const hole5 = result.holes.find((hole) => hole.number === 5);
		const hole2 = result.holes.find((hole) => hole.number === 2);

		expect(hole5?.failures.some((failure) => failure.kind === 'missing-tee')).toBe(true);
		expect(hole5?.tee).toBeUndefined();

		// The fix: hole 5 still gets its own basket even without a tee, and it
		// is the globally cheaper (diagonal) assignment, not hole 2's leftover.
		expect(hole5?.basket?.xPx).toBe(100);
		expect(hole5?.basket?.yPx).toBe(6);
		expect(hole2?.basket?.xPx).toBe(150);
		expect(hole2?.basket?.yPx).toBe(210);

		// A tee-less basket has no ray to score polarity against.
		expect(hole5?.basket?.polarityCosine).toBeUndefined();
	});
});
