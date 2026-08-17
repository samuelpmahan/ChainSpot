import type { CvFunnelRuntimeSnapshot, SurfacedCandidateObservation } from './funnelRuntime';
import {
	summarizeLandmarkFunnel,
	type LandmarkFunnelMetric,
	type LandmarkScore,
	type LandmarkTrace,
	type LocalSnapTrace,
	type ObservableBoolean
} from './landmarkTrace';

export type NotInstrumented = 'not-instrumented';
export const NOT_INSTRUMENTED: NotInstrumented = 'not-instrumented';

export interface LandmarkAuditRow {
	readonly course: string;
	readonly hole: number;
	readonly object: 'tee' | 'basket';
	readonly detected: ObservableBoolean;
	readonly candidateRank: number | NotInstrumented;
	readonly scoreConfidence: LandmarkScore | NotInstrumented;
	readonly assignedHole: number | NotInstrumented;
	readonly assignmentCorrect: ObservableBoolean;
	readonly recommended: boolean;
	readonly surfaced: ObservableBoolean;
	readonly snapped: ObservableBoolean;
	readonly semanticPointErrorPx: number | NotInstrumented;
	readonly userCorrect: ObservableBoolean;
	readonly failureStage: string | NotInstrumented;
}

function pointDistance(a: { xPx: number; yPx: number }, b: { xPx: number; yPx: number }): number {
	return Math.hypot(a.xPx - b.xPx, a.yPx - b.yPx);
}

function surfaceMatch(trace: LandmarkTrace, observation: SurfacedCandidateObservation): boolean {
	if (trace.kind !== observation.kind || !trace.recommendation.emitted) return false;
	if (
		trace.recommendation.candidateIndex !== undefined &&
		observation.candidateIndex !== undefined &&
		trace.recommendation.candidateIndex === observation.candidateIndex
	) return true;
	return Boolean(trace.recommendation.point && pointDistance(trace.recommendation.point, observation) <= 1.5);
}

function snapMatchScore(trace: LandmarkTrace, snap: LocalSnapTrace): number | null {
	if (!trace.recommendation.point || (snap.kind && snap.kind !== trace.kind)) return null;
	const distanceToRecommendation = pointDistance(trace.recommendation.point, snap.clickPx);
	if (snap.knownRecommendationDistancePx !== undefined) {
		const discrepancy = Math.abs(distanceToRecommendation - snap.knownRecommendationDistancePx);
		return discrepancy <= 1.5 ? discrepancy : null;
	}
	// Older/early-failure traces may not have known-recommendation evidence.
	// Only associate a snap by click proximity when it is still local enough
	// to be the same recommendation; otherwise keep it unassigned.
	return distanceToRecommendation <= 96 ? distanceToRecommendation : null;
}

function failureStage(trace: LandmarkTrace): string | undefined {
	if (trace.detected === false) return 'candidate-generation';
	if (!trace.recommendation.emitted) return trace.candidates.length > 0 ? 'assignment/recommendation' : 'candidate-generation';
	if (trace.assignedHoleCorrect === false) return 'assignment';
	if (trace.surface.eligible === false) return 'ui-gating';
	if (trace.surface.surfaced === false) return 'ui-surface';
	if (trace.snap?.attempted && !trace.snap.accepted) return 'local-snap-detection';
	if (trace.snap?.settled === false) return 'local-snap-settle';
	if (trace.groundTruth?.userCorrect === false) return 'semantic-anchor';
	return undefined;
}

/**
 * Merge the live browser/worker observation channel into static detector
 * traces. Surfaced points are exact `acceptCandidate()` boundary events;
 * worker snap outcomes remain `settled=not-instrumented` until the correction
 * log (or another authoritative settle observation) proves the async result
 * actually changed state.
 */
export function mergeRuntimeFunnelObservations(
	traces: readonly LandmarkTrace[],
	snapshot: CvFunnelRuntimeSnapshot
): readonly LandmarkTrace[] {
	return traces.map((trace) => {
		const surfaced = [...snapshot.surfacedCandidates].reverse().find((observation) => surfaceMatch(trace, observation));
		let snap: LocalSnapTrace | undefined;
		let bestSnapScore = Number.POSITIVE_INFINITY;
		for (const candidate of snapshot.localSnaps) {
			const matchScore = snapMatchScore(trace, candidate);
			if (matchScore === null || matchScore > bestSnapScore) continue;
			bestSnapScore = matchScore;
			snap = { ...candidate, settled: candidate.settled ?? 'not-instrumented' };
		}

		let groundTruth = trace.groundTruth;
		if (surfaced && groundTruth) {
			const finalErrorPx = pointDistance(surfaced, groundTruth);
			groundTruth = {
				...groundTruth,
				finalErrorPx,
				userCorrect: finalErrorPx <= groundTruth.tolerancePx
			};
		}
		const { failureStage: _oldFailure, ...withoutFailure } = trace;
		const partial: LandmarkTrace = {
			...withoutFailure,
			surface: {
				...trace.surface,
				surfaced: surfaced ? true : trace.surface.eligible === false ? false : trace.surface.surfaced
			},
			...(snap ? { snap } : {}),
			...(groundTruth ? { groundTruth } : {})
		};
		const nextFailure = failureStage(partial);
		return { ...partial, ...(nextFailure ? { failureStage: nextFailure } : {}) };
	});
}

export function buildLandmarkAuditRows(
	course: string,
	traces: readonly LandmarkTrace[]
): readonly LandmarkAuditRow[] {
	return traces.map((trace) => {
		const selected = trace.assignedCandidateIndex === undefined
			? undefined
			: trace.candidates.find((candidate) => candidate.rawIndex === trace.assignedCandidateIndex);
		const errorPx = trace.groundTruth?.finalErrorPx ?? trace.groundTruth?.assignmentErrorPx;
		return {
			course,
			hole: trace.holeNumber,
			object: trace.kind,
			detected: trace.detected,
			candidateRank: selected?.rank ?? NOT_INSTRUMENTED,
			scoreConfidence: trace.recommendation.score ?? selected?.score ?? NOT_INSTRUMENTED,
			assignedHole: trace.recommendation.emitted ? trace.holeNumber : NOT_INSTRUMENTED,
			assignmentCorrect: trace.assignedHoleCorrect ?? NOT_INSTRUMENTED,
			recommended: trace.recommendation.emitted,
			surfaced: trace.surface.surfaced,
			snapped: trace.snap?.settled ?? NOT_INSTRUMENTED,
			semanticPointErrorPx: errorPx ?? NOT_INSTRUMENTED,
			userCorrect: trace.groundTruth?.userCorrect ?? NOT_INSTRUMENTED,
			failureStage: trace.failureStage ?? NOT_INSTRUMENTED
		};
	});
}

export interface LandmarkFunnelAudit {
	readonly course: string;
	readonly rows: readonly LandmarkAuditRow[];
	readonly metrics: readonly LandmarkFunnelMetric[];
}

export function buildLandmarkFunnelAudit(course: string, traces: readonly LandmarkTrace[]): LandmarkFunnelAudit {
	return { course, rows: buildLandmarkAuditRows(course, traces), metrics: summarizeLandmarkFunnel(traces) };
}
