import { describe, expect, it } from 'vitest';
import { summarizeLandmarkFunnel, type LandmarkTrace } from '../../src/lib/cv/landmarkTrace';
import {
	buildCourseLandmarkTraces,
	mergeCorrectionEventsIntoLandmarkTraces
} from '../../src/lib/autoAnnotation/courseLandmarkTrace';
import type { CourseDetectionResult } from '../../src/lib/autoAnnotation/basketDetection';
import type { CorrectionEvent } from '../../src/lib/correctionLog';

function baseTrace(overrides: Partial<LandmarkTrace> = {}): LandmarkTrace {
	return {
		holeNumber: 1,
		kind: 'tee',
		detected: true,
		candidates: [{ candidateId: 'tee:0', rawIndex: 0, xPx: 10, yPx: 10, retained: true }],
		assignmentHistory: [],
		assignedCandidateId: 'tee:0',
		assignedCandidateIndex: 0,
		assignedHoleCorrect: true,
		recommendation: { emitted: true, candidateId: 'tee:0', candidateIndex: 0, point: { xPx: 10, yPx: 10 } },
		surface: { eligible: true, surfaced: 'not-instrumented' },
		semanticAnchor: 'tee-component-centroid',
		...overrides
	};
}

describe('summarizeLandmarkFunnel', () => {
	it('never folds not-instrumented rows into a success or failure denominator', () => {
		const metrics = summarizeLandmarkFunnel([
			baseTrace({ surface: { eligible: true, surfaced: true }, snap: { attempted: true, accepted: true, clickPx: { xPx: 9, yPx: 9 } } }),
			baseTrace({ holeNumber: 2, assignedHoleCorrect: false, surface: { eligible: false, surfaced: 'not-instrumented' } }),
			baseTrace({ holeNumber: 3, detected: 'not-instrumented', assignedHoleCorrect: 'not-instrumented', recommendation: { emitted: false }, surface: { eligible: 'not-instrumented', surfaced: 'not-instrumented' } })
		]);

		const assigned = metrics.find((metric) => metric.name === 'correctly-assigned')!;
		expect(assigned).toMatchObject({ numerator: 1, denominator: 2, notInstrumented: 1 });
		const surfaced = metrics.find((metric) => metric.name === 'surfaced')!;
		expect(surfaced).toMatchObject({ numerator: 1, denominator: 1, notInstrumented: 2 });
		const snapped = metrics.find((metric) => metric.name === 'snapped')!;
		expect(snapped).toMatchObject({ numerator: 1, denominator: 1, notInstrumented: 2 });
	});
});

function pancakeDetectionWithSwap(): CourseDetectionResult {
	return {
		numberDetection: { candidates: [], anchor: null } as never,
		tees: [],
		baskets: [],
		rawMaskObjects: {
			tees: [
				{ xPx: 10, yPx: 10, orientationDeg: 0, widthPx: 20, heightPx: 10, areaPx: 100, fill: 0.5 },
				{ xPx: 90, yPx: 10, orientationDeg: 0, widthPx: 20, heightPx: 10, areaPx: 100, fill: 0.5 }
			],
			badges: [],
			baskets: [
				{ xPx: 20, yPx: 80, centerXPx: 20, centerYPx: 70, widthPx: 12, heightPx: 20, areaPx: 120, fill: 0.5 },
				{ xPx: 80, yPx: 80, centerXPx: 80, centerYPx: 70, widthPx: 12, heightPx: 20, areaPx: 120, fill: 0.5 }
			],
			diagnostics: { brightComponentCount: 4, darkComponentCount: 2, basketShapePoolCount: 2, badgeShapePoolCount: 2, thresholds: { brightValueMin: 210, brightSaturationMax: 45, darkValueMax: 45 } }
		},
		p3Ownership: {
			teeBadgeHits: [], straightBasketHits: [], unresolvedTeeIndexes: [], teeConflictIndexes: [], straightBasketConflictHoleNumbers: [],
			teeDiagnostics: [
				{ teeIndex: 0, candidateHoleNumbers: [1], candidateBadgeEvidence: [{ holeNumber: 1, badgeAxisErrorPx: 2 }], teeBadgeStatus: 'owned', holeNumber: 1, straightBasketStatus: 'notEvaluated' },
				{ teeIndex: 1, candidateHoleNumbers: [2], candidateBadgeEvidence: [{ holeNumber: 2, badgeAxisErrorPx: 3 }], teeBadgeStatus: 'owned', holeNumber: 2, straightBasketStatus: 'notEvaluated' }
			]
		},
		p5SparseAssignment: {
			assignments: [
				{ teeIndex: 0, assignedHoleNumber: 1, candidateHoleNumbers: [1], assignedAxisErrorPx: 2, p4Status: 'unresolved', p4HoleNumber: null, status: 'assigned', reason: 'hungarian' },
				{ teeIndex: 1, assignedHoleNumber: 2, candidateHoleNumbers: [2], assignedAxisErrorPx: 3, p4Status: 'unresolved', p4HoleNumber: null, status: 'assigned', reason: 'hungarian' }
			],
			assignedTees: 2, unresolvedTees: 0, totalAssignmentCost: 5, duplicateBadges: [], disallowedAssignmentsRejected: 0, perfectMatchingFound: true
		},
		p6LowParBasketAssignment: {
			assignments: [
				{ holeNumber: 1, teeIndex: 0, p4BasketStatus: 'unresolved', p4BasketIndex: null, candidateBasketCount: 2, candidatesBeforeGate: 2, candidatesAfterGate: 2, gateFallbackUsed: false, assignedBasketIndex: 1, assignedForwardAngleDeg: 5, assignmentReason: 'lowPar', lowParScore: 0.7, status: 'lowParAssigned' },
				{ holeNumber: 2, teeIndex: 1, p4BasketStatus: 'unresolved', p4BasketIndex: null, candidateBasketCount: 2, candidatesBeforeGate: 2, candidatesAfterGate: 2, gateFallbackUsed: false, assignedBasketIndex: 0, assignedForwardAngleDeg: 5, assignmentReason: 'lowPar', lowParScore: 0.8, status: 'lowParAssigned' }
			],
			candidates: [
				{ holeNumber: 1, basketIndex: 0, forwardProjectionPx: 1, forwardAngleDeg: 5, passedForwardGate: true, lowParScore: 0.6, valid: true, rankWithinHole: 2 },
				{ holeNumber: 1, basketIndex: 1, forwardProjectionPx: 1, forwardAngleDeg: 5, passedForwardGate: true, lowParScore: 0.7, valid: true, rankWithinHole: 1 },
				{ holeNumber: 2, basketIndex: 0, forwardProjectionPx: 1, forwardAngleDeg: 5, passedForwardGate: true, lowParScore: 0.8, valid: true, rankWithinHole: 1 },
				{ holeNumber: 2, basketIndex: 1, forwardProjectionPx: 1, forwardAngleDeg: 5, passedForwardGate: true, lowParScore: 0.5, valid: true, rankWithinHole: 2 }
			],
			lockedByP4: 0, lockedByZeroBend: 0, assignedByLowPar: 2, unresolved: 0, duplicateBaskets: [], disallowedAssignmentsRejected: 0, totalAssignmentCost: -1.5, lowParHigherIsBetter: true, forwardGateAngleDeg: 80, candidatesBeforeGate: 4, candidatesAfterGate: 4, gateFallbackHoles: 0,
			swapAdjudication: {
				pairsConsidered: 1, swapsApplied: 1, changedHoleNumbers: [1, 2], ms: 0,
				pairs: [{ holeA: 1, holeB: 2, basketX: 0, basketY: 1, lowParAX: 0.9, lowParAY: 0.7, lowParBX: 0.8, lowParBY: 0.9, ribbonAX: 50, ribbonAY: 5, ribbonBX: 5, ribbonBY: 50, currentRibbonCost: 100, swappedRibbonCost: 10, ribbonImprovementPx: 90, swapApplied: true }]
			}
		},
		grammar: {
			holes: [
				{ number: 1, tee: { candidateIndex: 0, xPx: 10, yPx: 10, detectorConfidence: 1, confidence: 1, distancePx: 2 }, basket: { candidateIndex: 1, xPx: 80, yPx: 80, detectorConfidence: 1, confidence: 1, distancePx: 0, cost: 0 }, confidence: 1, status: 'ready', failures: [] },
				{ number: 2, tee: { candidateIndex: 1, xPx: 90, yPx: 10, detectorConfidence: 1, confidence: 1, distancePx: 3 }, basket: { candidateIndex: 0, xPx: 20, yPx: 80, detectorConfidence: 1, confidence: 1, distancePx: 0, cost: 0 }, confidence: 1, status: 'ready', failures: [] }
			],
			failures: [],
			unassigned: { numberBadgeCandidateIndexes: [], teeCandidateIndexes: [], basketCandidateIndexes: [] }
		}
	} as unknown as CourseDetectionResult;
}

describe('buildCourseLandmarkTraces', () => {
	it('keeps tee ownership stages distinct and basket candidates ranked by the real P6 score', () => {
		const traces = buildCourseLandmarkTraces(pancakeDetectionWithSwap());
		const tee1 = traces.find((trace) => trace.holeNumber === 1 && trace.kind === 'tee')!;
		expect(tee1.assignmentHistory.map((step) => step.stage)).toContain('p3');
		expect(tee1.assignmentHistory.map((step) => step.stage)).toContain('p5');
		const basket1 = traces.find((trace) => trace.holeNumber === 1 && trace.kind === 'basket')!;
		expect(basket1.candidates[0]).toMatchObject({ rawIndex: 1, rank: 1, score: { name: 'p6.lowParScore', value: 0.7 } });
	});
});

describe('correction-log merge', () => {
	it('marks a proposal as surfaced and a changed raw drop as an actually-settled snap', () => {
		const trace = baseTrace({
			groundTruth: { xPx: 12, yPx: 12, tolerancePx: 3, assignmentErrorPx: 2.8, assignmentCorrect: true }
		});
		const event: CorrectionEvent = {
			schemaVersion: 1,
			eventId: 'e1',
			timestamp: '2026-08-17T00:00:00.000Z',
			appVersion: '0.1.0',
			projectId: 'p', imageId: 'i', imageSha256: null,
			holeNumber: 1, endpoint: 'tee',
			priorProposal: { xPx: 10, yPx: 10, confidence: 0.8, detector: 'courseGrammar-hungarian', gateDecision: 'auto-accepted' },
			userAction: 'move',
			finalValue: { xPx: 12, yPx: 12 },
			interactionMeta: { rawDropPx: { xPx: 11, yPx: 11 } }
		};
		const merged = mergeCorrectionEventsIntoLandmarkTraces([trace], [event])[0];
		expect(merged.surface.surfaced).toBe(true);
		expect(merged.snap).toMatchObject({ attempted: true, accepted: true });
		expect(merged.groundTruth).toMatchObject({ finalErrorPx: 0, userCorrect: true });
	});
});
