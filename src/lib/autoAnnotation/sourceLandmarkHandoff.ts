/**
 * Source-landmark evidence carried from Stitch Map into annotation (CHSPT-79).
 *
 * CHSPT-51 already owns source-raster -> composite transform propagation in
 * `sourceSpaceDetection.ts`. This module never reimplements that transform.
 * It has two layers:
 *
 * 1. the research identity-aware handoff (`SourceLandmarkHandoff`) used when
 *    a landmark already has a stable semantic id; and
 * 2. the production physical-evidence handoff used immediately after Stitch
 *    Map, where badge/basket bodies are already localized but may not yet
 *    have hole identity.
 *
 * Physical basket observations deliberately retain TWO points: the repeated
 * sprite center (registration/fusion point) and the downstream semantic
 * basket point at the bottom-center of the sprite bbox. Stitch registration
 * must align the same rendered sprite pixel-for-pixel; the semantic point is
 * derived only after the final source transform is known.
 */
import type { Candidate } from '../cv/types';
import type { CompositePoint, CompositeProvenance, SourceTransform } from '../domain/provenance';
import type {
	SemanticFamilyAbstentionReason,
	SemanticFamilyScale,
	SemanticLandmark,
	SemanticLandmarkBatchResult,
	SemanticLandmarkFamily
} from '../stitch/semanticLandmarks';
import {
	mapSourceCandidateToComposite,
	type CompositeObservation
} from './sourceSpaceDetection';

// ---------------------------------------------------------------------------
// Identity-aware research handoff
// ---------------------------------------------------------------------------

export type SourceLandmarkKind = 'basket' | 'tee' | 'hole-number' | 'other';

export interface SemanticLandmarkRef {
	readonly kind: SourceLandmarkKind;
	readonly id: string;
}

export interface SourceLandmarkObservation<TCandidate extends Candidate = Candidate>
	extends CompositeObservation<TCandidate> {
	readonly landmark: SemanticLandmarkRef;
}

export interface SourceLandmarkHandoff<TCandidate extends Candidate = Candidate> {
	readonly schemaVersion: 1;
	readonly compositeIdentity: string;
	readonly expected: readonly SemanticLandmarkRef[];
	readonly observations: readonly SourceLandmarkObservation<TCandidate>[];
}

export interface FusedSourceLandmark<TCandidate extends Candidate = Candidate> {
	readonly landmark: SemanticLandmarkRef;
	readonly compositePoint: CompositePoint;
	readonly confidence?: number;
	readonly evidence: 'single-source' | 'multi-source';
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

export function canSkipCompositeDetector(
	handoff: SourceLandmarkHandoff,
	plan: SourceLandmarkResolutionPlan,
	kind: SourceLandmarkKind
): boolean {
	const expected = handoff.expected.filter((landmark) => landmark.kind === kind);
	if (expected.length === 0) return false;
	const unresolved = new Set(
		plan.fallback.filter((item) => item.landmark.kind === kind).map((item) => refKey(item.landmark))
	);
	const resolved = new Set(
		plan.resolved.filter((item) => item.landmark.kind === kind).map((item) => refKey(item.landmark))
	);
	return expected.every(
		(landmark) => resolved.has(refKey(landmark)) && !unresolved.has(refKey(landmark))
	);
}

export function sourceLandmarkObservation<TCandidate extends Candidate>(
	landmark: SemanticLandmarkRef,
	observation: CompositeObservation<TCandidate>
): SourceLandmarkObservation<TCandidate> {
	return { landmark, ...observation };
}

// ---------------------------------------------------------------------------
// Production physical source evidence (identity may not exist yet)
// ---------------------------------------------------------------------------

export type SourceLandmarkCompleteness = 'complete' | 'incomplete' | 'unknown';

export interface PhysicalLandmarkCandidate extends Candidate {
	readonly family: SemanticLandmarkFamily;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly areaPx: number;
	readonly fill: number;
}

export interface SourcePhysicalLandmarkObservation {
	readonly sourceId: string;
	readonly family: SemanticLandmarkFamily;
	/** Exact physical sprite/body center in the unwarped source raster. */
	readonly sourcePoint: Readonly<{ xPx: number; yPx: number }>;
	/** Basket bottom-center for domain semantics; badge == physical center. */
	readonly sourceSemanticPoint: Readonly<{ xPx: number; yPx: number }>;
	readonly sourceGeometry: Readonly<{
		widthPx: number;
		heightPx: number;
		areaPx: number;
		fill: number;
	}>;
	/** Exact transform used for this handoff, not the earlier auto proposal. */
	readonly sourceTransform: SourceTransform;
	/** Physical sprite/body center after final source->composite propagation. */
	readonly compositePoint: CompositePoint;
	/** Domain semantic point after the SAME final transform. */
	readonly compositeSemanticPoint: CompositePoint;
}

export interface FusedPhysicalLandmark {
	readonly clusterId: string;
	readonly family: SemanticLandmarkFamily;
	readonly compositePoint: CompositePoint;
	readonly compositeSemanticPoint: CompositePoint;
	readonly evidence: 'single-source' | 'multi-source';
	readonly sourceIds: readonly string[];
	readonly observationCount: number;
	readonly rmsResidualPx: number;
	readonly spreadPx: number;
	readonly observations: readonly SourcePhysicalLandmarkObservation[];
}

export interface SourcePhysicalLandmarkEvidence {
	readonly schemaVersion: 1;
	readonly compositeIdentity: string;
	readonly completeness: Readonly<Record<SemanticLandmarkFamily, SourceLandmarkCompleteness>>;
	readonly localizationAbstention: Readonly<
		Record<SemanticLandmarkFamily, SemanticFamilyAbstentionReason | null>
	>;
	readonly batchScales: Readonly<Partial<Record<SemanticLandmarkFamily, SemanticFamilyScale>>>;
	readonly observations: readonly SourcePhysicalLandmarkObservation[];
	readonly fused: readonly FusedPhysicalLandmark[];
	readonly fusionMs: number;
}

export interface BuildPhysicalEvidenceOptions {
	readonly maxDisagreementPx?: number;
	readonly now?: () => number;
}

function nowMs(): number {
	return typeof performance !== 'undefined' && typeof performance.now === 'function'
		? performance.now()
		: Date.now();
}

function physicalCandidate(landmark: SemanticLandmark): PhysicalLandmarkCandidate {
	return {
		family: landmark.family,
		xPx: landmark.xPx,
		yPx: landmark.yPx,
		widthPx: landmark.widthPx,
		heightPx: landmark.heightPx,
		areaPx: landmark.areaPx,
		fill: landmark.fill
	};
}

function semanticPointOf(candidate: PhysicalLandmarkCandidate): { xPx: number; yPx: number } {
	return candidate.family === 'basket'
		? { xPx: candidate.xPx, yPx: candidate.yPx + candidate.heightPx / 2 }
		: { xPx: candidate.xPx, yPx: candidate.yPx };
}

interface MutableCluster {
	readonly family: SemanticLandmarkFamily;
	readonly observations: SourcePhysicalLandmarkObservation[];
}

function centroid(
	observations: readonly SourcePhysicalLandmarkObservation[],
	key: 'compositePoint' | 'compositeSemanticPoint'
): CompositePoint {
	return {
		xPx: observations.reduce((sum, observation) => sum + observation[key].xPx, 0) / observations.length,
		yPx: observations.reduce((sum, observation) => sum + observation[key].yPx, 0) / observations.length
	};
}

function maxPairwiseDistance(observations: readonly SourcePhysicalLandmarkObservation[]): number {
	let max = 0;
	for (let i = 0; i < observations.length; i += 1) {
		for (let j = i + 1; j < observations.length; j += 1) {
			max = Math.max(max, distance(observations[i].compositePoint, observations[j].compositePoint));
		}
	}
	return max;
}

function fusePhysicalObservations(
	observations: readonly SourcePhysicalLandmarkObservation[],
	maxDisagreementPx: number
): FusedPhysicalLandmark[] {
	const ordered = [...observations].sort(
		(a, b) =>
			a.family.localeCompare(b.family) ||
			a.compositePoint.yPx - b.compositePoint.yPx ||
			a.compositePoint.xPx - b.compositePoint.xPx ||
			a.sourceId.localeCompare(b.sourceId)
	);
	const clusters: MutableCluster[] = [];
	for (const observation of ordered) {
		const target = clusters.find((cluster) => {
			if (cluster.family !== observation.family) return false;
			if (cluster.observations.some((existing) => existing.sourceId === observation.sourceId)) return false;
			return cluster.observations.every(
				(existing) => distance(existing.compositePoint, observation.compositePoint) <= maxDisagreementPx
			);
		});
		if (target) target.observations.push(observation);
		else clusters.push({ family: observation.family, observations: [observation] });
	}
	return clusters.map((cluster, index) => {
		const point = centroid(cluster.observations, 'compositePoint');
		const semanticPoint = centroid(cluster.observations, 'compositeSemanticPoint');
		const rmsResidualPx = Math.sqrt(
			cluster.observations.reduce(
				(sum, observation) => sum + distance(observation.compositePoint, point) ** 2,
				0
			) / cluster.observations.length
		);
		return {
			clusterId: `${cluster.family}-${index + 1}`,
			family: cluster.family,
			compositePoint: point,
			compositeSemanticPoint: semanticPoint,
			evidence: cluster.observations.length > 1 ? 'multi-source' : 'single-source',
			sourceIds: cluster.observations.map((observation) => observation.sourceId),
			observationCount: cluster.observations.length,
			rmsResidualPx,
			spreadPx: maxPairwiseDistance(cluster.observations),
			observations: [...cluster.observations]
		};
	});
}

/**
 * Rebinds Stitch Map's source-space landmark batch to the CURRENT sealed
 * provenance. Pairing is source-id first, then stable source order with a
 * dimension check so legacy/manual UI source-id rebinding does not discard
 * factual source observations. The current SourceCapture transform is always
 * the transform propagated downstream.
 *
 * Completeness intentionally starts UNKNOWN: physical localization can say
 * what it saw, not prove how many hole landmarks should exist. Badge identity
 * / expected-set construction may upgrade this later. This fail-closed state
 * is what prevents Annotate Course from suppressing global fallback merely
 * because the source scan returned a non-empty list.
 */
export function buildPhysicalSourceLandmarkEvidence(
	batch: SemanticLandmarkBatchResult,
	provenance: CompositeProvenance,
	options: BuildPhysicalEvidenceOptions = {}
): SourcePhysicalLandmarkEvidence {
	const maxDisagreementPx = options.maxDisagreementPx ?? DEFAULT_SOURCE_LANDMARK_MAX_DISAGREEMENT_PX;
	const now = options.now ?? nowMs;
	if (!Number.isFinite(maxDisagreementPx) || maxDisagreementPx < 0) {
		throw new Error(`buildPhysicalSourceLandmarkEvidence: maxDisagreementPx must be >= 0, got ${maxDisagreementPx}`);
	}
	const started = now();
	const observations: SourcePhysicalLandmarkObservation[] = [];
	for (let index = 0; index < provenance.sources.length; index += 1) {
		const source = provenance.sources[index];
		const semanticSource =
			batch.sources.find((candidate) => candidate.sourceId === source.sourceId) ?? batch.sources[index];
		if (!semanticSource) continue;
		if (semanticSource.widthPx !== source.widthPx || semanticSource.heightPx !== source.heightPx) continue;
		for (const landmark of semanticSource.landmarks) {
			const candidate = physicalCandidate(landmark);
			const propagated = mapSourceCandidateToComposite(source.sourceId, source.transform, candidate);
			const sourceSemanticPoint = semanticPointOf(candidate);
			const semanticPropagated = mapSourceCandidateToComposite(
				source.sourceId,
				source.transform,
				{ ...candidate, xPx: sourceSemanticPoint.xPx, yPx: sourceSemanticPoint.yPx }
			);
			observations.push({
				sourceId: source.sourceId,
				family: candidate.family,
				sourcePoint: { xPx: candidate.xPx, yPx: candidate.yPx },
				sourceSemanticPoint,
				sourceGeometry: {
					widthPx: candidate.widthPx,
					heightPx: candidate.heightPx,
					areaPx: candidate.areaPx,
					fill: candidate.fill
				},
				sourceTransform: source.transform,
				compositePoint: propagated.compositePoint,
				compositeSemanticPoint: semanticPropagated.compositePoint
			});
		}
	}
	const fused = fusePhysicalObservations(observations, maxDisagreementPx);
	return {
		schemaVersion: 1,
		compositeIdentity: provenance.finalRasterSha256,
		completeness: { badge: 'unknown', basket: 'unknown' },
		localizationAbstention: {
			badge: batch.diagnostics.badgeAbstention,
			basket: batch.diagnostics.basketAbstention
		},
		batchScales: batch.scales,
		observations,
		fused,
		fusionMs: now() - started
	};
}
