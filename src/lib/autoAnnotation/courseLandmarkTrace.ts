import type { CourseDetectionResult } from './basketDetection';
import type { CorrectionEvent } from '../correctionLog';
import type {
	LandmarkAssignmentStep,
	LandmarkGroundTruthTrace,
	LandmarkKind,
	LandmarkScore,
	LandmarkTrace,
	LandmarkTraceCandidate,
	ObservableBoolean
} from '../cv/landmarkTrace';

export interface CourseLandmarkTruth {
	readonly holeNumber: number;
	readonly tee?: { readonly xPx: number; readonly yPx: number };
	readonly basket?: { readonly xPx: number; readonly yPx: number };
}

export interface BuildCourseLandmarkTraceOptions {
	readonly autoApplyThreshold?: number;
	readonly truth?: readonly CourseLandmarkTruth[];
	readonly tolerancePx?: number;
}

const DEFAULT_AUTO_APPLY_THRESHOLD = 0.6;

function candidateId(kind: LandmarkKind, index: number): string {
	return `${kind}:${index}`;
}

function finiteScore(name: string, value: number | null | undefined, higherIsBetter?: boolean): LandmarkScore | undefined {
	return typeof value === 'number' && Number.isFinite(value)
		? { name, value, ...(higherIsBetter === undefined ? {} : { higherIsBetter }) }
		: undefined;
}

function distance(a: { xPx: number; yPx: number }, b: { xPx: number; yPx: number }): number {
	return Math.hypot(a.xPx - b.xPx, a.yPx - b.yPx);
}

function truthFor(
	truth: readonly CourseLandmarkTruth[] | undefined,
	holeNumber: number,
	kind: LandmarkKind,
	tolerancePx: number,
	point?: { xPx: number; yPx: number }
): LandmarkGroundTruthTrace | undefined {
	const hole = truth?.find((candidate) => candidate.holeNumber === holeNumber);
	const expected = kind === 'tee' ? hole?.tee : hole?.basket;
	if (!expected) return undefined;
	const assignmentErrorPx = point ? distance(point, expected) : undefined;
	return {
		xPx: expected.xPx,
		yPx: expected.yPx,
		tolerancePx,
		...(assignmentErrorPx === undefined
			? {}
			: { assignmentErrorPx, assignmentCorrect: assignmentErrorPx <= tolerancePx })
	};
}

function selectedPoint(
	detection: CourseDetectionResult,
	holeNumber: number,
	kind: LandmarkKind
): { candidateIndex: number; xPx: number; yPx: number; confidence: number } | undefined {
	const proposal = detection.grammar.holes.find((hole) => hole.number === holeNumber);
	const assignment = kind === 'tee' ? proposal?.tee : proposal?.basket;
	return assignment
		? {
			candidateIndex: assignment.candidateIndex,
			xPx: assignment.xPx,
			yPx: assignment.yPx,
			confidence: assignment.confidence
		}
		: undefined;
}

function pancakeTeeCandidates(detection: CourseDetectionResult, holeNumber: number): LandmarkTraceCandidate[] {
	const raw = detection.rawMaskObjects?.tees ?? [];
	const p3 = detection.p3Ownership;
	if (!p3) return [];
	const candidates: LandmarkTraceCandidate[] = [];
	for (const diagnostic of p3.teeDiagnostics) {
		const evidence = diagnostic.candidateBadgeEvidence.find((entry) => entry.holeNumber === holeNumber);
		if (!evidence) continue;
		const candidate = raw[diagnostic.teeIndex];
		if (!candidate) continue;
		candidates.push({
			candidateId: candidateId('tee', diagnostic.teeIndex),
			rawIndex: diagnostic.teeIndex,
			xPx: candidate.xPx,
			yPx: candidate.yPx,
			widthPx: candidate.widthPx,
			heightPx: candidate.heightPx,
			...(finiteScore('p1.appearanceNcc', candidate.appearanceScore, true)
				? { score: finiteScore('p1.appearanceNcc', candidate.appearanceScore, true)! }
				: {}),
			rankStage: 'p3.badge-axis-error',
			retained: true,
			// Rank filled below after sorting.
			...(finiteScore('p3.badgeAxisErrorPx', evidence.badgeAxisErrorPx, false)
				? {}
				: {})
		});
	}
	const ranked = candidates
		.map((candidate) => {
			const diagnostic = p3.teeDiagnostics.find((entry) => entry.teeIndex === candidate.rawIndex);
			const axisError = diagnostic?.candidateBadgeEvidence.find((entry) => entry.holeNumber === holeNumber)?.badgeAxisErrorPx ?? Number.POSITIVE_INFINITY;
			return { candidate, axisError };
		})
		.sort((a, b) => a.axisError - b.axisError);
	return ranked.map(({ candidate }, index) => ({ ...candidate, rank: index + 1 }));
}

function pancakeBasketCandidates(detection: CourseDetectionResult, holeNumber: number): LandmarkTraceCandidate[] {
	const raw = detection.rawMaskObjects?.baskets ?? [];
	const candidates = detection.p6LowParBasketAssignment?.candidates.filter((candidate) => candidate.holeNumber === holeNumber) ?? [];
	return candidates
		.slice()
		.sort((a, b) => a.rankWithinHole - b.rankWithinHole)
		.flatMap((candidate) => {
			const rawCandidate = raw[candidate.basketIndex];
			if (!rawCandidate) return [];
			const score = finiteScore('p6.lowParScore', candidate.lowParScore, true);
			return [{
				candidateId: candidateId('basket', candidate.basketIndex),
				rawIndex: candidate.basketIndex,
				xPx: rawCandidate.xPx,
				yPx: rawCandidate.yPx,
				widthPx: rawCandidate.widthPx,
				heightPx: rawCandidate.heightPx,
				...(score ? { score } : {}),
				rank: candidate.rankWithinHole,
				rankStage: 'p6.lowPar',
				retained: candidate.valid
			}];
		});
}

function legacyCandidates(detection: CourseDetectionResult, holeNumber: number, kind: LandmarkKind): LandmarkTraceCandidate[] {
	const proposal = detection.grammar.holes.find((hole) => hole.number === holeNumber);
	const assignment = kind === 'tee' ? proposal?.tee : proposal?.basket;
	if (!assignment) return [];
	const raw = kind === 'tee' ? detection.tees : detection.baskets;
	const candidate = raw[assignment.candidateIndex];
	if (!candidate) return [];
	const score = finiteScore(`${kind}.detectorScore`, candidate.score, true);
	return [{
		candidateId: candidateId(kind, assignment.candidateIndex),
		rawIndex: assignment.candidateIndex,
		xPx: candidate.xPx,
		yPx: candidate.yPx,
		widthPx: candidate.widthPx,
		heightPx: candidate.heightPx,
		...(score ? { score } : {}),
		rank: 1,
		rankStage: 'grammar-selected',
		retained: true
	}];
}

function teeHistory(detection: CourseDetectionResult, teeIndex: number): LandmarkAssignmentStep[] {
	const history: LandmarkAssignmentStep[] = [];
	const p3 = detection.p3Ownership?.teeDiagnostics.find((entry) => entry.teeIndex === teeIndex);
	if (p3?.teeBadgeStatus === 'owned' && p3.holeNumber !== undefined) {
		history.push({
			stage: 'p3',
			candidateId: candidateId('tee', teeIndex),
			candidateIndex: teeIndex,
			holeNumber: p3.holeNumber,
			reason: p3.teeBadgeStatus,
			...(finiteScore('p3.badgeAxisErrorPx', p3.badgeAxisErrorPx, false) ? { score: finiteScore('p3.badgeAxisErrorPx', p3.badgeAxisErrorPx, false)! } : {})
		});
	}
	const p4 = detection.p4RibbonOwnership?.teeResolutions.find((entry) => entry.teeIndex === teeIndex);
	if (p4?.status === 'resolved' && p4.resolvedHoleNumber !== undefined) {
		history.push({
			stage: 'p4',
			candidateId: candidateId('tee', teeIndex),
			candidateIndex: teeIndex,
			holeNumber: p4.resolvedHoleNumber,
			reason: p4.status
		});
	}
	const p5 = detection.p5SparseAssignment?.assignments.find((entry) => entry.teeIndex === teeIndex);
	if (p5?.assignedHoleNumber !== null && p5?.assignedHoleNumber !== undefined) {
		history.push({
			stage: 'p5',
			candidateId: candidateId('tee', teeIndex),
			candidateIndex: teeIndex,
			holeNumber: p5.assignedHoleNumber,
			reason: p5.reason,
			...(finiteScore('p5.assignedAxisErrorPx', p5.assignedAxisErrorPx, false) ? { score: finiteScore('p5.assignedAxisErrorPx', p5.assignedAxisErrorPx, false)! } : {})
		});
	}
	return history;
}

function basketHistory(detection: CourseDetectionResult, holeNumber: number, basketIndex: number): LandmarkAssignmentStep[] {
	const history: LandmarkAssignmentStep[] = [];
	const p3 = detection.p3Ownership?.straightBasketHits.find((entry) => entry.basketIndex === basketIndex);
	if (p3) {
		history.push({
			stage: 'p3',
			candidateId: candidateId('basket', basketIndex),
			candidateIndex: basketIndex,
			holeNumber: p3.holeNumber,
			reason: 'straight-ray-hit',
			score: { name: 'p3.basketAxisErrorPx', value: p3.basketAxisErrorPx, higherIsBetter: false }
		});
	}
	const original = detection.p6LowParBasketAssignment?.originalP6?.assignments.find((entry) => entry.holeNumber === holeNumber);
	if (original?.assignedBasketIndex !== null && original?.assignedBasketIndex !== undefined) {
		history.push({
			stage: 'p6.1',
			candidateId: candidateId('basket', original.assignedBasketIndex),
			candidateIndex: original.assignedBasketIndex,
			holeNumber,
			reason: original.assignmentReason,
			...(finiteScore('p6.lowParScore', original.lowParScore, true) ? { score: finiteScore('p6.lowParScore', original.lowParScore, true)! } : {})
		});
	}
	const finalAssignment = detection.p6LowParBasketAssignment?.assignments.find((entry) => entry.holeNumber === holeNumber);
	if (finalAssignment?.assignedBasketIndex !== null && finalAssignment?.assignedBasketIndex !== undefined) {
		history.push({
			stage: original ? 'p6.2-final' : 'p6',
			candidateId: candidateId('basket', finalAssignment.assignedBasketIndex),
			candidateIndex: finalAssignment.assignedBasketIndex,
			holeNumber,
			reason: finalAssignment.assignmentReason,
			...(finiteScore('p6.lowParScore', finalAssignment.lowParScore, true) ? { score: finiteScore('p6.lowParScore', finalAssignment.lowParScore, true)! } : {})
		});
	}
	return history;
}

function detectedState(candidates: readonly LandmarkTraceCandidate[], groundTruth?: LandmarkGroundTruthTrace): ObservableBoolean {
	if (groundTruth) return candidates.some((candidate) => distance(candidate, groundTruth) <= groundTruth.tolerancePx);
	return candidates.length > 0 ? true : 'not-instrumented';
}

function failureStage(trace: Omit<LandmarkTrace, 'failureStage'>): string | undefined {
	if (trace.detected === false) return 'candidate-generation';
	if (trace.recommendation.emitted === false) return trace.candidates.length > 0 ? 'assignment/recommendation' : 'candidate-generation';
	if (trace.assignedHoleCorrect === false) return 'assignment';
	if (trace.surface.eligible === false) return 'ui-gating';
	if (trace.surface.surfaced === false) return 'ui-surface';
	if (trace.snap?.attempted && !trace.snap.accepted) return 'local-snap';
	if (trace.groundTruth?.userCorrect === false) return 'semantic-anchor';
	return undefined;
}

export function buildCourseLandmarkTraces(
	detection: CourseDetectionResult,
	options: BuildCourseLandmarkTraceOptions = {}
): readonly LandmarkTrace[] {
	const threshold = options.autoApplyThreshold ?? DEFAULT_AUTO_APPLY_THRESHOLD;
	const tolerancePx = options.tolerancePx ?? 0;
	const traces: LandmarkTrace[] = [];
	for (const proposal of detection.grammar.holes) {
		for (const kind of ['tee', 'basket'] as const) {
			const selected = selectedPoint(detection, proposal.number, kind);
			const candidates = detection.rawMaskObjects
				? kind === 'tee'
					? pancakeTeeCandidates(detection, proposal.number)
					: pancakeBasketCandidates(detection, proposal.number)
				: legacyCandidates(detection, proposal.number, kind);
			const gt = options.truth && tolerancePx > 0
				? truthFor(options.truth, proposal.number, kind, tolerancePx, selected)
				: undefined;
			const assignmentCorrect: ObservableBoolean = gt?.assignmentCorrect ?? 'not-instrumented';
			const selectedCandidateId = selected ? candidateId(kind, selected.candidateIndex) : undefined;
			const selectedCandidate = selected
				? candidates.find((candidate) => candidate.rawIndex === selected.candidateIndex)
				: undefined;
			const assignmentHistory = selected
				? kind === 'tee'
					? teeHistory(detection, selected.candidateIndex)
					: basketHistory(detection, proposal.number, selected.candidateIndex)
				: [];
			const thresholdScore = selected && Number.isFinite(selected.confidence)
				? finiteScore('grammar.confidence', selected.confidence, true)
				: undefined;
			const eligible: ObservableBoolean = thresholdScore
				? thresholdScore.value >= threshold
				: 'not-instrumented';
			const recommendationScore = selectedCandidate?.score ?? thresholdScore;
			const partial: Omit<LandmarkTrace, 'failureStage'> = {
				holeNumber: proposal.number,
				kind,
				detected: detectedState(candidates, gt),
				candidates,
				assignmentHistory,
				...(selectedCandidateId ? { assignedCandidateId: selectedCandidateId } : {}),
				...(selected ? { assignedCandidateIndex: selected.candidateIndex } : {}),
				assignedHoleCorrect: assignmentCorrect,
				recommendation: selected
					? {
						emitted: true,
						candidateId: selectedCandidateId,
						candidateIndex: selected.candidateIndex,
						point: { xPx: selected.xPx, yPx: selected.yPx },
						...(recommendationScore ? { score: recommendationScore } : {})
					}
					: { emitted: false },
				surface: {
					eligible,
					threshold,
					...(thresholdScore ? { thresholdScore } : {}),
					reason: eligible === false ? 'below-auto-apply-threshold' : undefined,
					surfaced: 'not-instrumented'
				},
				semanticAnchor: kind === 'basket'
					? 'basket-stem-base (raw mask x=bbox center, y=maxY)'
					: 'tee component centroid; downstream launch-point semantic contract is not explicit',
				...(gt ? { groundTruth: gt } : {})
			};
			traces.push({ ...partial, ...(failureStage(partial) ? { failureStage: failureStage(partial)! } : {}) });
		}
	}
	return traces;
}

/**
 * Enriches a detection trace with browser correction-log evidence. A log row
 * can prove a proposal reached a user interaction and can prove snap settle
 * when rawDropPx differs from finalValue. It deliberately does not infer a
 * snap attempt from a plain manual point.
 */
export function mergeCorrectionEventsIntoLandmarkTraces(
	traces: readonly LandmarkTrace[],
	events: readonly CorrectionEvent[]
): readonly LandmarkTrace[] {
	return traces.map((trace) => {
		const event = [...events]
			.reverse()
			.find((candidate) => candidate.holeNumber === trace.holeNumber && candidate.endpoint === trace.kind);
		if (!event) return trace;
		const surfaced = event.priorProposal !== null && event.userAction !== 'place';
		const raw = event.interactionMeta?.rawDropPx;
		const finalValue = event.finalValue;
		const snapped = Boolean(
			raw && finalValue && (raw.xPx !== finalValue.xPx || raw.yPx !== finalValue.yPx)
		);
		const groundTruth = trace.groundTruth && finalValue
			? (() => {
				const finalErrorPx = distance(finalValue, trace.groundTruth!);
				return { ...trace.groundTruth!, finalErrorPx, userCorrect: finalErrorPx <= trace.groundTruth!.tolerancePx };
			})()
			: trace.groundTruth;
		const partial: Omit<LandmarkTrace, 'failureStage'> = {
			...trace,
			surface: { ...trace.surface, surfaced },
			...(raw
				? {
					snap: {
						attempted: true,
						accepted: snapped,
						clickPx: raw,
						...(finalValue ? { snappedPoint: finalValue } : {}),
						...(snapped ? {} : { rejectReason: 'marker-changed' as const })
					}
				}
				: {}),
			...(groundTruth ? { groundTruth } : {})
		};
		const { failureStage: _old, ...withoutFailure } = partial as LandmarkTrace;
		const nextFailure = failureStage(withoutFailure);
		return { ...withoutFailure, ...(nextFailure ? { failureStage: nextFailure } : {}) };
	});
}
