import { describe, expect, it } from 'vitest';
import { buildLandmarkFunnelAudit, mergeRuntimeFunnelObservations } from '../../src/lib/cv/funnelAudit';
import type { CvFunnelRuntimeSnapshot } from '../../src/lib/cv/funnelRuntime';
import type { LandmarkTrace } from '../../src/lib/cv/landmarkTrace';

function trace(): LandmarkTrace {
	return {
		holeNumber: 7,
		kind: 'tee',
		detected: true,
		candidates: [{ candidateId: 'tee:3', rawIndex: 3, xPx: 100, yPx: 100, rank: 1, rankStage: 'p3.badge-axis-error', retained: true }],
		assignmentHistory: [{ stage: 'p5', candidateId: 'tee:3', candidateIndex: 3, holeNumber: 7, score: { name: 'p5.assignedAxisErrorPx', value: 2, higherIsBetter: false } }],
		assignedCandidateId: 'tee:3',
		assignedCandidateIndex: 3,
		assignedHoleCorrect: true,
		recommendation: { emitted: true, candidateId: 'tee:3', candidateIndex: 3, point: { xPx: 100, yPx: 100 }, score: { name: 'p5.assignedAxisErrorPx', value: 2, higherIsBetter: false } },
		surface: { eligible: true, surfaced: 'not-instrumented' },
		semanticAnchor: 'tee-component-centroid',
		groundTruth: { xPx: 101, yPx: 100, tolerancePx: 5, assignmentErrorPx: 1, assignmentCorrect: true }
	};
}

describe('mergeRuntimeFunnelObservations', () => {
	it('proves surface independently from worker snap acceptance and does not call worker acceptance a settled snap', () => {
		const snapshot: CvFunnelRuntimeSnapshot = {
			surfacedCandidates: [{ sequence: 1, observedAtMs: Date.now(), kind: 'tee', candidateIndex: 3, xPx: 100, yPx: 100, widthPx: 42, heightPx: 20 }],
			localSnaps: [{
				kind: 'tee', attempted: true, accepted: true,
				clickPx: { xPx: 110, yPx: 100 }, snappedPoint: { xPx: 101, yPx: 100 },
				knownRecommendationDistancePx: 10, knownRecommendationInRadius: true,
				bestCandidateScore: { name: 'tee.detectorScore', value: 0.8, higherIsBetter: true }
			}]
		};
		const merged = mergeRuntimeFunnelObservations([trace()], snapshot)[0];
		expect(merged.surface.surfaced).toBe(true);
		expect(merged.snap).toMatchObject({ accepted: true, settled: 'not-instrumented' });
		expect(merged.groundTruth).toMatchObject({ finalErrorPx: 1, userCorrect: true });

		const audit = buildLandmarkFunnelAudit('fixture', [merged]);
		expect(audit.rows[0]).toMatchObject({
			course: 'fixture', hole: 7, object: 'tee', detected: true,
			candidateRank: 1, assignmentCorrect: true, recommended: true,
			surfaced: true, snapped: 'not-instrumented', semanticPointErrorPx: 1, userCorrect: true
		});
		const snapped = audit.metrics.find((metric) => metric.name === 'snapped')!;
		expect(snapped).toMatchObject({ numerator: 0, denominator: 0, notInstrumented: 1 });
	});
});
