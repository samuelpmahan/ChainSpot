export type LandmarkKind = 'tee' | 'basket';

export type ObservableBoolean = boolean | 'not-instrumented';

export interface LandmarkScore {
	/** Exact score name from the producing stage. Never call this confidence unless that stage does. */
	readonly name: string;
	readonly value: number;
	readonly higherIsBetter?: boolean;
}

export interface LandmarkTraceCandidate {
	readonly candidateId: string;
	readonly rawIndex: number;
	readonly xPx: number;
	readonly yPx: number;
	readonly widthPx?: number;
	readonly heightPx?: number;
	readonly score?: LandmarkScore;
	/** Rank among candidates for this hole at the named stage, when the stage exposes one. */
	readonly rank?: number;
	readonly rankStage?: string;
	readonly retained: boolean;
}

export interface LandmarkAssignmentStep {
	readonly stage: string;
	readonly candidateId: string;
	readonly candidateIndex: number;
	readonly holeNumber: number;
	readonly reason?: string;
	readonly score?: LandmarkScore;
}

export interface LandmarkRecommendationTrace {
	readonly emitted: boolean;
	readonly candidateId?: string;
	readonly candidateIndex?: number;
	readonly point?: { readonly xPx: number; readonly yPx: number };
	/** Real stage score only. Undefined when the producer exposes no comparable score. */
	readonly score?: LandmarkScore;
}

export interface LandmarkSurfaceTrace {
	/** Whether the recommendation passes the browser's auto-apply policy. */
	readonly eligible: ObservableBoolean;
	readonly threshold?: number;
	readonly thresholdScore?: LandmarkScore;
	readonly reason?: string;
	/** Actual authoritative/UI placement, only true/false when observed rather than inferred. */
	readonly surfaced: ObservableBoolean;
}

export type LocalSnapRejectReason =
	| 'invalid-click'
	| 'invalid-calibration'
	| 'no-footprint'
	| 'empty-crop'
	| 'missing-raster-channel'
	| 'no-candidate'
	| 'outside-radius'
	| 'below-score'
	| 'stale-result'
	| 'marker-changed';

export interface LocalSnapTrace {
	/** Present on live worker traces; optional for older/offline callers. */
	readonly kind?: LandmarkKind;
	readonly attempted: boolean;
	/** Local detector accepted a candidate. This is not yet proof the marker settled. */
	readonly accepted: boolean;
	/** Actual async settle result; `not-instrumented` when only the worker outcome is known. */
	readonly settled?: ObservableBoolean;
	readonly rejectReason?: LocalSnapRejectReason;
	readonly clickPx: { readonly xPx: number; readonly yPx: number };
	readonly snappedPoint?: { readonly xPx: number; readonly yPx: number };
	readonly candidateCount?: number;
	readonly inRadiusCandidateCount?: number;
	readonly bestCandidateScore?: LandmarkScore;
	readonly snapRadiusPx?: number;
	readonly featureFootprintPx?: number;
	readonly calibrationSource?: string;
	readonly knownRecommendationCandidateIndex?: number;
	readonly knownRecommendationDistancePx?: number;
	readonly knownRecommendationInRadius?: boolean;
}

export interface LandmarkGroundTruthTrace {
	readonly xPx: number;
	readonly yPx: number;
	readonly tolerancePx: number;
	readonly assignmentErrorPx?: number;
	readonly assignmentCorrect?: boolean;
	readonly finalErrorPx?: number;
	readonly userCorrect?: boolean;
}

export interface LandmarkTrace {
	readonly holeNumber: number;
	readonly kind: LandmarkKind;
	/** A per-hole raw detection statement is only possible with truth or an ownership edge. */
	readonly detected: ObservableBoolean;
	readonly candidates: readonly LandmarkTraceCandidate[];
	readonly assignmentHistory: readonly LandmarkAssignmentStep[];
	readonly assignedCandidateId?: string;
	readonly assignedCandidateIndex?: number;
	readonly assignedHoleCorrect?: ObservableBoolean;
	readonly recommendation: LandmarkRecommendationTrace;
	readonly surface: LandmarkSurfaceTrace;
	readonly snap?: LocalSnapTrace;
	readonly semanticAnchor: string;
	readonly groundTruth?: LandmarkGroundTruthTrace;
	readonly failureStage?: string;
}

export interface LandmarkFunnelMetric {
	readonly name:
		| 'detected'
		| 'candidate-present'
		| 'correctly-assigned'
		| 'recommended'
		| 'surfaced'
		| 'snapped'
		| 'semantically-correct';
	readonly numerator: number;
	readonly denominator: number;
	readonly notInstrumented: number;
	readonly definition: string;
}

function counted(values: readonly ObservableBoolean[]): { numerator: number; denominator: number; notInstrumented: number } {
	let numerator = 0;
	let denominator = 0;
	let notInstrumented = 0;
	for (const value of values) {
		if (value === 'not-instrumented') {
			notInstrumented += 1;
			continue;
		}
		denominator += 1;
		if (value) numerator += 1;
	}
	return { numerator, denominator, notInstrumented };
}

/**
 * Stage-explicit aggregate vocabulary. A denominator contains only rows for
 * which that stage is actually observable; missing instrumentation is never
 * silently converted to failure or success.
 */
export function summarizeLandmarkFunnel(traces: readonly LandmarkTrace[]): readonly LandmarkFunnelMetric[] {
	const detected = counted(traces.map((trace) => trace.detected));
	const candidatePresent = counted(
		traces.map((trace) => trace.detected === 'not-instrumented' ? 'not-instrumented' : trace.candidates.length > 0)
	);
	const assigned = counted(traces.map((trace) => trace.assignedHoleCorrect ?? 'not-instrumented'));
	const recommended = counted(traces.map((trace) => trace.recommendation.emitted));
	const surfaced = counted(traces.map((trace) => trace.surface.surfaced));
	const snapped = counted(traces.map((trace) => trace.snap?.settled ?? 'not-instrumented'));
	const semantic = counted(traces.map((trace) => trace.groundTruth?.userCorrect ?? 'not-instrumented'));
	return [
		{ ...detected, name: 'detected', definition: 'A raw detector emitted/owned a hypothesis for this hole/object, or truth matching proved one existed.' },
		{ ...candidatePresent, name: 'candidate-present', definition: 'At least one retained candidate is observable for this hole/object.' },
		{ ...assigned, name: 'correctly-assigned', definition: 'The selected candidate belongs to the numbered hole under the declared ground-truth tolerance.' },
		{ ...recommended, name: 'recommended', definition: 'The course pipeline emitted a tee/basket endpoint for this numbered hole.' },
		{ ...surfaced, name: 'surfaced', definition: 'The recommendation was actually observed at the CV-to-authoritative-state acceptance boundary.' },
		{ ...snapped, name: 'snapped', definition: 'The asynchronous local-snap result actually settled into authoritative annotation state; worker acceptance alone does not count.' },
		{ ...semantic, name: 'semantically-correct', definition: 'The final user-visible point is within the declared semantic-anchor tolerance.' }
	];
}
