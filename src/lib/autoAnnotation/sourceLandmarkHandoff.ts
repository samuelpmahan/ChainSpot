/**
 * Source-landmark evidence carried from Stitch Map into annotation (CHSPT-79).
 *
 * CHSPT-51 already solved source-raster -> composite transform propagation in
 * `sourceSpaceDetection.ts`; this module intentionally does not reimplement a
 * single transform.  It starts from those `CompositeObservation`s, attaches a
 * semantic landmark identity, fuses duplicate source observations, preserves
 * provenance, and says exactly which semantic landmarks still need a
 * composite-space fallback detector.
 */
import type { Candidate } from '../cv/types';
import type { CompositePoint } from '../domain/provenance';
import type { CompositeObservation } from './sourceSpaceDetection';

export type SourceLandmarkKind = 'basket' | 'tee' | 'hole-number' | 'other';

export interface SemanticLandmarkRef {
	readonly kind: SourceLandmarkKind;
	/** Stable semantic identity inside one course, e.g. `hole-4:basket`. */
	readonly id: string;
}

export interface SourceLandmarkObservation<TCandidate extends Candidate = Candidate>
	extends CompositeObservation<TCandidate> {
	readonly landmark: SemanticLandmarkRef;
}

export interface SourceLandmarkHandoff<TCandidate extends Candidate = Candidate> {
	readonly schemaVersion: 1;
	/** Ties this evidence to the exact stitched-image handoff that produced it. */
	readonly compositeIdentity: string;
	/**
	 * Landmarks Stitch Map/semantic evidence says should exist.  Completeness is
	 * explicit; absence from `observations` therefore means fallback, never
	 * accidental suppression.
	 */
	readonly expected: readonly SemanticLandmarkRef[];
	readonly observations: readonly SourceLandmarkObservation<TCandidate>[];
}

export interface FusedSourceLandmark<TCandidate extends Candidate = Candidate> {
	readonly landmark: SemanticLandmarkRef;
	readonly compositePoint: CompositePoint;
	readonly confidence?: number;
	readonly evidence: 'single-source' | 'multi-source';
	/** Every contributing source-space candidate is retained for diagnostics/corpus use. */
	readonly provenance: readonly SourceLandmarkObservation<TCandidate>[];
}

export type SourceLandmarkFallbackReason = 'missing-source-observation' | 'source-disagreement';

export interface SourceLandmarkFallback {
	readonly landmark: SemanticLandmarkRef;
	readonly reason: SourceLandmarkFallbackReason;
	readonly sourceIds: readonly string[];
}

export interface SourceLandmarkResolutionPlan<TCandidate extends Candidate = Candidate> {
	readonly compositeIdentity: string;
	readonly resolved: readonly FusedSourceLandmark<TCandidate>[];
	readonly fallback: readonly SourceLandmarkFallback[];
}

export interface FuseSourceLandmarkOptions {
	/** Maximum pairwise disagreement before source evidence abstains instead of averaging. */
	readonly maxDisagreementPx?: number;
}

export const DEFAULT_SOURCE_LANDMARK_MAX_DISAGREEMENT_PX = 16;

function refKey(ref: SemanticLandmarkRef): string {
	return `${ref.kind}:${ref.id}`;
}

function distance(a: CompositePoint, b: CompositePoint): number {
	return Math.hypot(a.xPx - b.xPx, a.yPx - b.yPx);
}

function confidenceOf(candidate: Candidate): number | undefined {
	return typeof candidate.score === 'number' && Number.isFinite(candidate.score) ? candidate.score : undefined;
}

function fusePoints<TCandidate extends Candidate>(
	landmark: SemanticLandmarkRef,
	observations: readonly SourceLandmarkObservation<TCandidate>[]
): FusedSourceLandmark<TCandidate> {
	let weightedX = 0;
	let weightedY = 0;
	let totalWeight = 0;
	let confidenceWeight = 0;
	let weightedConfidence = 0;
	for (const observation of observations) {
		const confidence = confidenceOf(observation.sourceCandidate);
		// A detector without a score still has one factual observation; use an
		// equal geometric weight rather than inventing confidence for it.
		const weight = confidence !== undefined && confidence > 0 ? confidence : 1;
		weightedX += observation.compositePoint.xPx * weight;
		weightedY += observation.compositePoint.yPx * weight;
		totalWeight += weight;
		if (confidence !== undefined) {
			weightedConfidence += confidence * weight;
			confidenceWeight += weight;
		}
	}
	return {
		landmark,
		compositePoint: { xPx: weightedX / totalWeight, yPx: weightedY / totalWeight },
		...(confidenceWeight > 0 ? { confidence: weightedConfidence / confidenceWeight } : {}),
		evidence: observations.length > 1 ? 'multi-source' : 'single-source',
		provenance: [...observations]
	};
}

/**
 * Resolves expected semantic landmarks from already-transformed source
 * observations. Missing evidence and inconsistent overlapping-source evidence
 * abstain explicitly and request fallback rather than being silently averaged.
 */
export function resolveSourceLandmarkHandoff<TCandidate extends Candidate>(
	handoff: SourceLandmarkHandoff<TCandidate>,
	options: FuseSourceLandmarkOptions = {}
): SourceLandmarkResolutionPlan<TCandidate> {
	const maxDisagreementPx = options.maxDisagreementPx ?? DEFAULT_SOURCE_LANDMARK_MAX_DISAGREEMENT_PX;
	if (!Number.isFinite(maxDisagreementPx) || maxDisagreementPx < 0) {
		throw new Error(`resolveSourceLandmarkHandoff: maxDisagreementPx must be >= 0, got ${maxDisagreementPx}`);
	}

	const byRef = new Map<string, SourceLandmarkObservation<TCandidate>[]>();
	for (const observation of handoff.observations) {
		const key = refKey(observation.landmark);
		const list = byRef.get(key) ?? [];
		list.push(observation);
		byRef.set(key, list);
	}

	const resolved: FusedSourceLandmark<TCandidate>[] = [];
	const fallback: SourceLandmarkFallback[] = [];
	const seenExpected = new Set<string>();
	for (const landmark of handoff.expected) {
		const key = refKey(landmark);
		if (seenExpected.has(key)) continue;
		seenExpected.add(key);
		const observations = byRef.get(key) ?? [];
		if (observations.length === 0) {
			fallback.push({ landmark, reason: 'missing-source-observation', sourceIds: [] });
			continue;
		}

		let disagrees = false;
		for (let i = 0; i < observations.length && !disagrees; i += 1) {
			for (let j = i + 1; j < observations.length; j += 1) {
				if (distance(observations[i].compositePoint, observations[j].compositePoint) > maxDisagreementPx) {
					disagrees = true;
					break;
				}
			}
		}
		if (disagrees) {
			fallback.push({
				landmark,
				reason: 'source-disagreement',
				sourceIds: [...new Set(observations.map((observation) => observation.sourceId))]
			});
			continue;
		}
		resolved.push(fusePoints(landmark, observations));
	}

	return { compositeIdentity: handoff.compositeIdentity, resolved, fallback };
}

/**
 * A blanket composite detector for `kind` is removable only when there is at
 * least one expected landmark of that kind AND every one is already resolved
 * from source evidence. Unknown completeness must preserve fallback.
 */
export function canSkipCompositeDetector(
	handoff: SourceLandmarkHandoff,
	plan: SourceLandmarkResolutionPlan,
	kind: SourceLandmarkKind
): boolean {
	const expected = handoff.expected.filter((landmark) => landmark.kind === kind);
	if (expected.length === 0) return false;
	const unresolved = new Set(plan.fallback.filter((item) => item.landmark.kind === kind).map((item) => refKey(item.landmark)));
	const resolved = new Set(plan.resolved.filter((item) => item.landmark.kind === kind).map((item) => refKey(item.landmark)));
	return expected.every((landmark) => resolved.has(refKey(landmark)) && !unresolved.has(refKey(landmark)));
}

/** Build the first-class payload directly from CHSPT-51 CompositeObservations without touching transform math. */
export function sourceLandmarkObservation<TCandidate extends Candidate>(
	landmark: SemanticLandmarkRef,
	observation: CompositeObservation<TCandidate>
): SourceLandmarkObservation<TCandidate> {
	return { landmark, ...observation };
}
