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

	it('does not invent a fallback when there are no useful candidates', () => {
		const recommendation = recommendNextAnchor({
			candidates: [],
			holes: [{ number: 4, status: 'incomplete', confidence: 0.9, missing: ['tee'], associations: [] }]
		});
		expect(recommendation).toMatchObject({ kind: 'none', reason: 'no-useful-candidate' });
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

	it('can surface an incomplete hole through a weak shared candidate', () => {
		const recommendation = recommendNextAnchor(map({ confirmedCandidateIds: ['tee:0', 'tee:1'] }));
		expect(recommendation.kind).toBe('candidate');
		if (recommendation.kind === 'candidate') {
			expect(recommendation.candidateId).toBe('basket:0');
			expect(recommendation.rationale.targetStatus).toBe('review');
		}
	});
});
