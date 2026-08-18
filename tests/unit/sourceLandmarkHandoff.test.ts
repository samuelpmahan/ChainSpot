import { describe, expect, it } from 'vitest';
import {
	canSkipCompositeDetector,
	resolveSourceLandmarkHandoff,
	sourceLandmarkObservation,
	type SemanticLandmarkRef,
	type SourceLandmarkHandoff
} from '../../src/lib/autoAnnotation/sourceLandmarkHandoff';

const basket4: SemanticLandmarkRef = { kind: 'basket', id: 'hole-4:basket' };
const basket5: SemanticLandmarkRef = { kind: 'basket', id: 'hole-5:basket' };

function observation(
	landmark: SemanticLandmarkRef,
	sourceId: string,
	xPx: number,
	yPx: number,
	score = 0.9
) {
	return sourceLandmarkObservation(landmark, {
		sourceId,
		sourceCandidate: { xPx: xPx - 100, yPx: yPx - 50, score },
		compositePoint: { xPx, yPx }
	});
}

describe('source landmark handoff', () => {
	it('fuses overlapping source observations while preserving both source-space candidates', () => {
		const handoff: SourceLandmarkHandoff = {
			schemaVersion: 1,
			compositeIdentity: 'stitched-sha-fixture',
			expected: [basket4],
			observations: [
				observation(basket4, 'left-source', 400, 300, 0.95),
				observation(basket4, 'right-source', 404, 298, 0.85)
			]
		};
		const plan = resolveSourceLandmarkHandoff(handoff, { maxDisagreementPx: 10 });
		expect(plan.fallback).toEqual([]);
		expect(plan.resolved).toHaveLength(1);
		expect(plan.resolved[0].evidence).toBe('multi-source');
		expect(plan.resolved[0].provenance.map((item) => item.sourceId)).toEqual(['left-source', 'right-source']);
		expect(plan.resolved[0].compositePoint.xPx).toBeGreaterThan(400);
		expect(plan.resolved[0].compositePoint.xPx).toBeLessThan(404);
		expect(canSkipCompositeDetector(handoff, plan, 'basket')).toBe(true);
	});

	it('keeps explicit fallback for a semantic basket not observed in any source', () => {
		const handoff: SourceLandmarkHandoff = {
			schemaVersion: 1,
			compositeIdentity: 'stitched-sha-fixture',
			expected: [basket4, basket5],
			observations: [observation(basket4, 'source-a', 400, 300)]
		};
		const plan = resolveSourceLandmarkHandoff(handoff);
		expect(plan.resolved.map((item) => item.landmark.id)).toEqual(['hole-4:basket']);
		expect(plan.fallback).toEqual([
			{ landmark: basket5, reason: 'missing-source-observation', sourceIds: [] }
		]);
		expect(canSkipCompositeDetector(handoff, plan, 'basket')).toBe(false);
	});

	it('abstains to fallback instead of averaging mutually inconsistent source observations', () => {
		const handoff: SourceLandmarkHandoff = {
			schemaVersion: 1,
			compositeIdentity: 'stitched-sha-fixture',
			expected: [basket4],
			observations: [
				observation(basket4, 'source-a', 100, 100),
				observation(basket4, 'source-b', 160, 100)
			]
		};
		const plan = resolveSourceLandmarkHandoff(handoff, { maxDisagreementPx: 16 });
		expect(plan.resolved).toEqual([]);
		expect(plan.fallback[0].reason).toBe('source-disagreement');
		expect(plan.fallback[0].sourceIds).toEqual(['source-a', 'source-b']);
		expect(canSkipCompositeDetector(handoff, plan, 'basket')).toBe(false);
	});

	it('never suppresses a detector when expected-set completeness is unknown', () => {
		const handoff: SourceLandmarkHandoff = {
			schemaVersion: 1,
			compositeIdentity: 'stitched-sha-fixture',
			expected: [],
			observations: [observation(basket4, 'source-a', 100, 100)]
		};
		const plan = resolveSourceLandmarkHandoff(handoff);
		expect(canSkipCompositeDetector(handoff, plan, 'basket')).toBe(false);
	});

	it('is generic across landmark kinds rather than basket-specific transform plumbing', () => {
		const badge: SemanticLandmarkRef = { kind: 'hole-number', id: 'hole-4:number' };
		const handoff: SourceLandmarkHandoff = {
			schemaVersion: 1,
			compositeIdentity: 'stitched-sha-fixture',
			expected: [badge],
			observations: [observation(badge, 'source-a', 220, 140)]
		};
		const plan = resolveSourceLandmarkHandoff(handoff);
		expect(plan.resolved[0].landmark).toEqual(badge);
		expect(canSkipCompositeDetector(handoff, plan, 'hole-number')).toBe(true);
	});
});
