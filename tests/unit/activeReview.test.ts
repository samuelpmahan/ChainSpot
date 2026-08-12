import { describe, expect, it } from 'vitest';
import {
	recommendNextAnchor,
	type ActiveReviewMap
} from '../../src/lib/autoAnnotation/activeReview';

function map(overrides: Partial<ActiveReviewMap> = {}): ActiveReviewMap {
	return {
		candidates: [
			{ id: 'tee:0', kind: 'tee', xPx: 0, yPx: 0, score: 0.8 },
			{ id: 'tee:1', kind: 'tee', xPx: 1, yPx: 0, score: 0.8 },
			{ id: 'basket:0', kind: 'basket', xPx: 0, yPx: 1, score: 0.8 }
		],
		holes: [
			{
				number: 1,
				anchor: { xPx: 0, yPx: 0 },
				status: 'ready',
				confidence: 0.9,
				missing: [],
				associations: [{ candidateId: 'tee:0', kind: 'tee', score: 0.9 }]
			},
			{
				number: 2,
				anchor: { xPx: 1, yPx: 0 },
				status: 'review',
				confidence: 0.4,
				missing: ['tee'],
				associations: [
					{ candidateId: 'tee:1', kind: 'tee', score: 0.5 },
					{ candidateId: 'tee:0', kind: 'tee', score: 0.5 },
					{ candidateId: 'basket:0', kind: 'basket', score: 0.5 }
				]
			}
		],
		...overrides
	};
}

describe('active review recommendation', () => {
	it('returns a concrete landmark shared by multiple hole hypotheses', () => {
		const recommendation = recommendNextAnchor(map());
		expect(recommendation.kind).toBe('candidate');
		if (recommendation.kind === 'candidate') {
			expect(['tee:0', 'tee:1']).toContain(recommendation.candidateId);
			expect(recommendation.rationale.competingHoleCount).toBeGreaterThan(0);
		}
	});

	it('flags an orphaned hole (no candidates anywhere) as needing manual placement, not a silent no-op', () => {
		// A hole with zero surviving candidates never enters the candidate ->
		// hole scoring loop, so it must not collapse into the same 0-score
		// "nothing to do" result as a genuinely empty queue.
		const recommendation = recommendNextAnchor({
			candidates: [],
			holes: [{ number: 4, status: 'incomplete', confidence: 0.9, missing: ['tee'], associations: [] }]
		});
		expect(recommendation).toMatchObject({ kind: 'none', reason: 'needs-manual-placement', holeNumber: 4 });
		if (recommendation.kind === 'none') expect(recommendation.score).toBeGreaterThan(0);
	});

	it('returns the best candidate found when the computation deadline is exceeded', () => {
		const timestamps = [0, 0, 2];
		const recommendation = recommendNextAnchor(map(), {
			deadlineMs: 1,
			now: () => timestamps.shift() ?? 2
		});
		expect(recommendation).toMatchObject({ kind: 'candidate', timedOut: true });
	});

	it('does not recommend a confirmed landmark again', () => {
		const recommendation = recommendNextAnchor(map({ confirmedCandidateIds: ['tee:0'] }));
		expect(recommendation.kind).toBe('candidate');
		if (recommendation.kind === 'candidate') expect(recommendation.candidateId).not.toBe('tee:0');
	});

	it('does not fall back to a kind-mismatched candidate for an incomplete hole', () => {
		// Hole 2 is missing a tee; once both tees are confirmed, basket:0 is the
		// only unconfirmed candidate left, but it's the wrong kind for what hole 2
		// needs. b51528e ("Recover occluded tees and constrain review locality")
		// added this kind-match requirement to the fallback path specifically so
		// it can't hand back a candidate that doesn't fill the hole's actual gap.
		// Hole 2 is now orphaned for 'tee' (no unconfirmed tee candidate left),
		// so it surfaces as needing manual placement instead of a silent no-op.
		const recommendation = recommendNextAnchor(map({ confirmedCandidateIds: ['tee:0', 'tee:1'] }));
		expect(recommendation).toMatchObject({ kind: 'none', reason: 'needs-manual-placement', holeNumber: 2 });
	});

	it('ranks an orphaned hole above a weak candidate suggestion elsewhere on the map', () => {
		// Hole 1 has one weak, uncontested tee candidate (low usefulness score).
		// Hole 5 is missing its tee entirely, with zero candidates nearby. The
		// orphaned hole must win: without it, the review queue would keep
		// offering the same low-value hole-1 suggestion while hole 5 is never
		// even mentioned.
		const recommendation = recommendNextAnchor({
			candidates: [{ id: 'tee:0', kind: 'tee', xPx: 0, yPx: 0, score: 0.5 }],
			holes: [
				{
					number: 1,
					anchor: { xPx: 0, yPx: 0 },
					status: 'ready',
					confidence: 0.85,
					missing: [],
					associations: [{ candidateId: 'tee:0', kind: 'tee', score: 0.2 }]
				},
				{
					number: 5,
					anchor: { xPx: 500, yPx: 500 },
					status: 'incomplete',
					confidence: 0.1,
					missing: ['tee'],
					associations: []
				}
			]
		});
		expect(recommendation).toMatchObject({ kind: 'none', reason: 'needs-manual-placement', holeNumber: 5 });
	});
});
