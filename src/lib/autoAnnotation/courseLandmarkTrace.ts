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
import type { CourseDetectionResult } from './basketDetection';

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

function id(kind: LandmarkKind, index: number): string {
	return `${kind}:${index}`;
}

function score(name: string, value: number | null | undefined, higherIsBetter?: boolean): LandmarkScore | undefined {
	return typeof value === 'number' && Number.isFinite(value)
		? { name, value, ...(higherIsBetter === undefined ? {} : { higherIsBetter }) }
		: undefined;
}

function distance(a: { xPx: number; yPx: number }, b: { xPx: number; yPx: number }): number {
	return Math.hypot(a.xPx - b.xPx, a.yPx - b.yPx);
}

function groundTruth(
	truth: readonly CourseLandmarkTruth[] | undefined,
	holeNumber: number,
	kind: LandmarkKind,
	tolerancePx: number,
	selected?: { xPx: number; yPx: number }
): LandmarkGroundTruthTrace | undefined {
	const hole = truth?.find((entry) => entry.holeNumber === holeNumber);
	const expected = kind === 'tee' ? hole?.tee : hole?.basket;
	if (!expected) return undefined;
	if (!selected) return { ...expected, tolerancePx };
	const assignmentErrorPx = distance(selected, expected);
	return {
		...expected,
		tolerancePx,
		assignmentErrorPx,
		assignmentCorrect: assignmentErrorPx <= tolerancePx
	};
}

function pancakeTeeCandidates(detection: CourseDetectionResult, holeNumber: number): LandmarkTraceCandidate[] {
	const raw = detection.rawMaskObjects?.tees ?? [];
	const diagnostics = detection.p3Ownership?.teeDiagnostics ?? [];
	return diagnostics
		.flatMap((diagnostic) => {
			const evidence = diagnostic.candidateBadgeEvidence.find((entry) => entry.holeNumber === holeNumber);
			const candidate = raw[diagnostic.teeIndex];
			if (!evidence || !candidate) return [];
			return [{ candidate, diagnostic, axisError: evidence.badgeAxisErrorPx }];
		})
		.sort((a, b) => a.axisError - b.axisError)
		.map(({ candidate, diagnostic }, index) => ({
			candidateId: id('tee', diagnostic.teeIndex),
			rawIndex: diagnostic.teeIndex,
			xPx: candidate.xPx,
			yPx: candidate.yPx,
			widthPx: candidate.widthPx,
			heightPx: candidate.heightPx,
			// P1 computes an appearance NCC gate but does not currently retain the
			// score on RawMaskTee. Do not manufacture a replacement here.
			rank: index + 1,
			rankStage: 'p3.badge-axis-error',
			retained: true
		}));
}

function pancakeBasketCandidates(detection: CourseDetectionResult, holeNumber: number): LandmarkTraceCandidate[] {
	const raw = detection.rawMaskObjects?.baskets ?? [];
	return (detection.p6LowParBasketAssignment?.candidates ?? [])
		.filter((candidate) => candidate.holeNumber === holeNumber)
		.slice()
		.sort((a, b) => a.rankWithinHole - b.rankWithinHole)
		.flatMap((candidate) => {
			const source = raw[candidate.basketIndex];
			if (!source) return [];
			const stageScore = score('p6.lowParScore', candidate.lowParScore, true);
			return [{
				candidateId: id('basket', candidate.basketIndex),
				rawIndex: candidate.basketIndex,
				xPx: source.xPx,
				yPx: source.yPx,
				widthPx: source.widthPx,
				heightPx: source.heightPx,
				...(stageScore ? { score: stageScore } : {}),
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
	const source = (kind === 'tee' ? detection.tees : detection.baskets)[assignment.candidateIndex];
	if (!source) return [];
	const detectorScore = score(`${kind}.detectorScore`, source.score, true);
	return [{
		candidateId: id(kind, assignment.candidateIndex),
		rawIndex: assignment.candidateIndex,
		xPx: source.xPx,
		yPx: source.yPx,
		widthPx: source.widthPx,
		heightPx: source.heightPx,
		...(detectorScore ? { score: detectorScore } : {}),
		rank: 1,
		rankStage: 'grammar-selected',
		retained: true
	}];
}

function teeHistory(detection: CourseDetectionResult, teeIndex: number): LandmarkAssignmentStep[] {
	const result: LandmarkAssignmentStep[] = [];
	const p3 = detection.p3Ownership?.teeDiagnostics.find((entry) => entry.teeIndex === teeIndex);
	if (p3?.teeBadgeStatus === 'owned' && p3.holeNumber !== undefined) {
		const stageScore = score('p3.badgeAxisErrorPx', p3.badgeAxisErrorPx, false);
		result.push({
			stage: 'p3', candidateId: id('tee', teeIndex), candidateIndex: teeIndex,
			holeNumber: p3.holeNumber, reason: p3.teeBadgeStatus,
			...(stageScore ? { score: stageScore } : {})
		});
	}
	const p4 = detection.p4RibbonOwnership?.teeResolutions.find((entry) => entry.teeIndex === teeIndex);
	if (p4?.status === 'resolved' && p4.resolvedHoleNumber !== undefined) {
		result.push({
			stage: 'p4', candidateId: id('tee', teeIndex), candidateIndex: teeIndex,
			holeNumber: p4.resolvedHoleNumber, reason: p4.status
		});
	}
	const p5 = detection.p5SparseAssignment?.assignments.find((entry) => entry.teeIndex === teeIndex);
	if (p5?.assignedHoleNumber !== null && p5?.assignedHoleNumber !== undefined) {
		const stageScore = score('p5.assignedAxisErrorPx', p5.assignedAxisErrorPx, false);
		result.push({
			stage: 'p5', candidateId: id('tee', teeIndex), candidateIndex: teeIndex,
			holeNumber: p5.assignedHoleNumber, reason: p5.reason,
			...(stageScore ? { score: stageScore } : {})
		});
	}
	return result;
}

function basketHistory(detection: CourseDetectionResult, holeNumber: number, finalBasketIndex: number): LandmarkAssignmentStep[] {
	const result: LandmarkAssignmentStep[] = [];
	const p3 = detection.p3Ownership?.straightBasketHits.find((entry) => entry.basketIndex === finalBasketIndex);
	if (p3) {
		result.push({
			stage: 'p3', candidateId: id('basket', p3.basketIndex), candidateIndex: p3.basketIndex,
			holeNumber: p3.holeNumber, reason: 'straight-ray-hit',
			score: { name: 'p3.basketAxisErrorPx', value: p3.basketAxisErrorPx, higherIsBetter: false }
		});
	}
	const original = detection.p6LowParBasketAssignment?.originalP6?.assignments.find((entry) => entry.holeNumber === holeNumber);
	if (original?.assignedBasketIndex !== null && original?.assignedBasketIndex !== undefined) {
		const stageScore = score('p6.lowParScore', original.lowParScore, true);
		result.push({
			stage: 'p6.1', candidateId: id('basket', original.assignedBasketIndex), candidateIndex: original.assignedBasketIndex,
			holeNumber, reason: original.assignmentReason,
			...(stageScore ? { score: stageScore } : {})
		});
	}
	const final = detection.p6LowParBasketAssignment?.assignments.find((entry) => entry.holeNumber === holeNumber);
	if (final?.assignedBasketIndex !== null && final?.assignedBasketIndex !== undefined) {
		const stageScore = score('p6.lowParScore', final.lowParScore, true);
		result.push({
			stage: original ? 'p6.2-final' : 'p6',
			candidateId: id('basket', final.assignedBasketIndex), candidateIndex: final.assignedBasketIndex,
			holeNumber, reason: final.assignmentReason,
			...(stageScore ? { score: stageScore } : {})
		});
	}
	return result;
}

function earliestFailure(trace: Omit<LandmarkTrace, 'failureStage'>): string | undefined {
	if (trace.detected === false) return 'candidate-generation';
	if (!trace.recommendation.emitted) return trace.candidates.length ? 'assignment/recommendation' : 'candidate-generation';
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
			const assignment = kind === 'tee' ? proposal.tee : proposal.basket;
			const selected = assignment
				? { candidateIndex: assignment.candidateIndex, xPx: assignment.xPx, yPx: assignment.yPx, confidence: assignment.confidence }
				: undefined;
			const candidates = detection.rawMaskObjects
				? kind === 'tee' ? pancakeTeeCandidates(detection, proposal.number) : pancakeBasketCandidates(detection, proposal.number)
				: legacyCandidates(detection, proposal.number, kind);
			const gt = options.truth && tolerancePx > 0
				? groundTruth(options.truth, proposal.number, kind, tolerancePx, selected)
				: undefined;
			const assignmentCorrect: ObservableBoolean = gt?.assignmentCorrect ?? 'not-instrumented';
			const detected: ObservableBoolean = gt
				? candidates.some((candidate) => distance(candidate, gt) <= gt.tolerancePx)
				: candidates.length > 0 ? true : 'not-instrumented';
			const selectedCandidate = selected ? candidates.find((candidate) => candidate.rawIndex === selected.candidateIndex) : undefined;
			const thresholdScore = selected ? score('grammar.confidence', selected.confidence, true) : undefined;
			const eligible: ObservableBoolean = thresholdScore ? thresholdScore.value >= threshold : 'not-instrumented';
			const partial: Omit<LandmarkTrace, 'failureStage'> = {
				holeNumber: proposal.number,
				kind,
				detected,
				candidates,
				assignmentHistory: selected
					? kind === 'tee' ? teeHistory(detection, selected.candidateIndex) : basketHistory(detection, proposal.number, selected.candidateIndex)
					: [],
				...(selected ? { assignedCandidateId: id(kind, selected.candidateIndex), assignedCandidateIndex: selected.candidateIndex } : {}),
				assignedHoleCorrect: assignmentCorrect,
				recommendation: selected
					? {
						emitted: true,
						candidateId: id(kind, selected.candidateIndex),
						candidateIndex: selected.candidateIndex,
						point: { xPx: selected.xPx, yPx: selected.yPx },
						...(selectedCandidate?.score ? { score: selectedCandidate.score } : thresholdScore ? { score: thresholdScore } : {})
					}
					: { emitted: false },
				surface: {
					eligible,
					threshold,
					...(thresholdScore ? { thresholdScore } : {}),
					...(eligible === false ? { reason: 'below-auto-apply-threshold' } : {}),
					surfaced: 'not-instrumented'
				},
				semanticAnchor: kind === 'basket'
					? 'basket-stem-base (raw mask x=bbox center, y=maxY)'
					: 'tee component centroid; downstream launch-point semantic contract is not explicit',
				...(gt ? { groundTruth: gt } : {})
			};
			const failureStage = earliestFailure(partial);
			traces.push({ ...partial, ...(failureStage ? { failureStage } : {}) });
		}
	}
	return traces;
}

/** Add user-observed surface/snap/final-point evidence from the existing local correction log. */
export function mergeCorrectionEventsIntoLandmarkTraces(
	traces: readonly LandmarkTrace[],
	events: readonly CorrectionEvent[]
): readonly LandmarkTrace[] {
	return traces.map((trace) => {
		const event = [...events].reverse().find(
			(candidate) => candidate.holeNumber === trace.holeNumber && candidate.endpoint === trace.kind
		);
		if (!event) return trace;
		const raw = event.interactionMeta?.rawDropPx;
		const finalValue = event.finalValue;
		const snapped = Boolean(raw && finalValue && (raw.xPx !== finalValue.xPx || raw.yPx !== finalValue.yPx));
		const nextGroundTruth = trace.groundTruth && finalValue
			? (() => {
				const finalErrorPx = distance(finalValue, trace.groundTruth!);
				return { ...trace.groundTruth!, finalErrorPx, userCorrect: finalErrorPx <= trace.groundTruth!.tolerancePx };
			})()
			: trace.groundTruth;
		const partial: Omit<LandmarkTrace, 'failureStage'> = {
			...trace,
			surface: {
				...trace.surface,
				// confirm/move/replace necessarily interacted with an existing proposal;
				// plain place is manual recovery and does not prove the proposal surfaced.
				surfaced: event.priorProposal !== null && event.userAction !== 'place'
			},
			...(raw ? {
				snap: {
					attempted: true,
					accepted: snapped,
					clickPx: raw,
					...(snapped && finalValue ? { snappedPoint: finalValue } : {})
				}
			} : {}),
			...(nextGroundTruth ? { groundTruth: nextGroundTruth } : {})
		};
		const failureStage = earliestFailure(partial);
		return { ...partial, ...(failureStage ? { failureStage } : {}) };
	});
}
