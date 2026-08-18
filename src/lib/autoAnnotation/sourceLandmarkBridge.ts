/**
 * Ephemeral Stitch Map -> Annotate Course evidence bridge (CHSPT-79/80).
 *
 * Source priors are keyed by the encoded composite's SHA-256. The first
 * automatic render bootstraps source-batch identity by exact source ids;
 * later manual transform rerenders are recognized by immutable source SHA
 * order and reproject the same source observations through the newly sealed
 * transforms. An unrelated same-size raster therefore cannot inherit priors.
 */
import type { CompositeProvenance } from '../domain/provenance';
import { sha256Hex } from '../imageIntake';
import {
  peekLatestSemanticLandmarkBatch,
  type SemanticLandmarkBatchResult
} from '../stitch/semanticLandmarks';
import type { BadgeGlyphClassification, BadgeGlyphMethod } from './badgeGlyphClassifier';
import type { SourceBadgeIdentityBatch } from './sourceBadgeIdentity';
import {
  buildPhysicalSourceLandmarkEvidence,
  type FusedPhysicalLandmark,
  type SourceLandmarkCompleteness,
  type SourcePhysicalLandmarkEvidence
} from './sourceLandmarkHandoff';

const MAX_SESSION_ENTRIES = 16;
const batchesBySourceSignature = new Map<string, SemanticLandmarkBatchResult>();
const identitiesBySourceSignature = new Map<string, SourceBadgeIdentityBatch>();
const evidenceByCompositeSha = new Map<string, AnnotateSourceLandmarkEvidence>();
let latestRenderedEvidence: AnnotateSourceLandmarkEvidence | null = null;

export interface FusedBadgeIdentity {
  readonly clusterId: string;
  readonly label?: number;
  readonly method?: BadgeGlyphMethod;
  readonly score: number;
  readonly runnerUpScore: number;
  readonly ambiguityMargin: number;
  readonly status: 'resolved' | 'unlabeled' | 'source-disagreement';
  readonly classifications: readonly BadgeGlyphClassification[];
}

export interface SourceBadgeLabelingPerformance {
  readonly templateLoadMs: number;
  readonly pureTsMs: number;
  readonly roiOpenCvMs: number;
  readonly roiOpenCvSourceCount: number;
  readonly wholeRasterDiscoveryCount: number;
}

export type CompletenessBasis =
  | 'unknown'
  | 'cross-family-contiguous-consensus'
  | 'identity-incomplete'
  | 'family-count-mismatch';

export type AnnotateSourceLandmarkEvidence = Omit<SourcePhysicalLandmarkEvidence, 'completeness'> & {
  readonly completeness: Readonly<Record<'badge' | 'basket', SourceLandmarkCompleteness>>;
  readonly expectedHoleNumbers: readonly number[] | null;
  readonly completenessBasis: CompletenessBasis;
  readonly badgeIdentities: readonly FusedBadgeIdentity[];
  readonly badgeLabeling?: SourceBadgeLabelingPerformance;
};

function sourceSignature(provenance: CompositeProvenance): string {
  return provenance.sources.map((source) => source.sha256).join(':');
}

function exactBatchIdentity(
  batch: SemanticLandmarkBatchResult,
  provenance: CompositeProvenance
): boolean {
  return (
    batch.sources.length === provenance.sources.length &&
    batch.sources.every((source, index) => {
      const expected = provenance.sources[index];
      return (
        source.sourceId === expected.sourceId &&
        source.widthPx === expected.widthPx &&
        source.heightPx === expected.heightPx
      );
    })
  );
}

function capMap<K, V>(map: Map<K, V>): void {
  while (map.size > MAX_SESSION_ENTRIES) {
    const first = map.keys().next();
    if (first.done) return;
    map.delete(first.value);
  }
}

interface CurrentSourceClassification {
  readonly sourceId: string;
  readonly xPx: number;
  readonly yPx: number;
  readonly classification: BadgeGlyphClassification;
}

function currentSourceClassifications(
  batch: SemanticLandmarkBatchResult,
  identity: SourceBadgeIdentityBatch,
  provenance: CompositeProvenance
): CurrentSourceClassification[] {
  const out: CurrentSourceClassification[] = [];
  for (let index = 0; index < provenance.sources.length; index += 1) {
    const currentSource = provenance.sources[index];
    const semanticSource = batch.sources[index];
    const identitySource = identity.sources[index];
    if (!semanticSource || !identitySource) continue;
    const badges = semanticSource.landmarks.filter((landmark) => landmark.family === 'badge');
    for (let badgeIndex = 0; badgeIndex < badges.length; badgeIndex += 1) {
      const classification = identitySource.classifications[badgeIndex];
      if (!classification) continue;
      out.push({
        sourceId: currentSource.sourceId,
        xPx: badges[badgeIndex].xPx,
        yPx: badges[badgeIndex].yPx,
        classification
      });
    }
  }
  return out;
}

function samePhysicalObservation(
  fused: FusedPhysicalLandmark,
  candidate: CurrentSourceClassification
): boolean {
  return fused.observations.some(
    (observation) =>
      observation.sourceId === candidate.sourceId &&
      Math.hypot(observation.sourcePoint.xPx - candidate.xPx, observation.sourcePoint.yPx - candidate.yPx) <= 1
  );
}

function fuseBadgeIdentity(
  fused: FusedPhysicalLandmark,
  candidates: readonly CurrentSourceClassification[]
): FusedBadgeIdentity {
  const classifications = candidates
    .filter((candidate) => samePhysicalObservation(fused, candidate))
    .map((candidate) => candidate.classification);
  const labeled = classifications.filter(
    (classification): classification is BadgeGlyphClassification & { readonly label: number } =>
      classification.label !== undefined
  );
  const labels = new Set(labeled.map((classification) => classification.label));
  const status: FusedBadgeIdentity['status'] =
    classifications.length === 0 || labeled.length !== classifications.length
      ? 'unlabeled'
      : labels.size === 1
        ? 'resolved'
        : 'source-disagreement';
  const score = labeled.length === 0 ? 0 : Math.min(...labeled.map((classification) => classification.bestScore));
  const runnerUpScore = labeled.length === 0
    ? 0
    : Math.max(...labeled.map((classification) => classification.runnerUpScore));
  const ambiguityMargin = labeled.length === 0
    ? 0
    : Math.min(...labeled.map((classification) => classification.ambiguityMargin));
  const method: BadgeGlyphMethod | undefined =
    status === 'resolved'
      ? labeled.every((classification) => classification.method === 'pure-ts')
        ? 'pure-ts'
        : 'roi-opencv'
      : undefined;
  return {
    clusterId: fused.clusterId,
    ...(status === 'resolved' ? { label: labeled[0].label } : {}),
    ...(method ? { method } : {}),
    score,
    runnerUpScore,
    ambiguityMargin,
    status,
    classifications
  };
}

function contiguousFromOne(labels: readonly number[]): boolean {
  if (labels.length === 0) return false;
  const sorted = [...labels].sort((a, b) => a - b);
  return sorted.every((label, index) => label === index + 1);
}

function enrichEvidence(
  physical: SourcePhysicalLandmarkEvidence,
  batch: SemanticLandmarkBatchResult,
  identity: SourceBadgeIdentityBatch | undefined,
  provenance: CompositeProvenance
): AnnotateSourceLandmarkEvidence {
  if (!identity) {
    return {
      ...physical,
      completeness: { badge: 'unknown', basket: 'unknown' },
      expectedHoleNumbers: null,
      completenessBasis: 'unknown',
      badgeIdentities: []
    };
  }
  const sourceClassifications = currentSourceClassifications(batch, identity, provenance);
  const fusedBadges = physical.fused.filter((landmark) => landmark.family === 'badge');
  const fusedBaskets = physical.fused.filter((landmark) => landmark.family === 'basket');
  const badgeIdentities = fusedBadges.map((badge) => fuseBadgeIdentity(badge, sourceClassifications));
  const resolvedLabels = badgeIdentities.flatMap((badge) => badge.label === undefined ? [] : [badge.label]);
  const allBadgesResolved =
    fusedBadges.length > 0 &&
    resolvedLabels.length === fusedBadges.length &&
    new Set(resolvedLabels).size === resolvedLabels.length &&
    contiguousFromOne(resolvedLabels);
  const familyLocalizationHealthy =
    physical.localizationAbstention.badge === null && physical.localizationAbstention.basket === null;
  const crossFamilyCountsAgree = fusedBaskets.length === fusedBadges.length;

  let completeness: Readonly<Record<'badge' | 'basket', SourceLandmarkCompleteness>> = {
    badge: allBadgesResolved ? 'unknown' : 'incomplete',
    basket: 'unknown'
  };
  let expectedHoleNumbers: readonly number[] | null = null;
  let completenessBasis: CompletenessBasis = allBadgesResolved ? 'unknown' : 'identity-incomplete';

  // This is deliberately stronger than "we found some baskets". Both
  // independent landmark families must produce the same cardinality, every
  // physical badge body must have a unique contiguous identity, and neither
  // family may have abstained. Only then do we materialize an explicit
  // expected set and allow downstream global rediscovery to disappear.
  if (allBadgesResolved && familyLocalizationHealthy && crossFamilyCountsAgree) {
    expectedHoleNumbers = Array.from({ length: resolvedLabels.length }, (_, index) => index + 1);
    completeness = { badge: 'complete', basket: 'complete' };
    completenessBasis = 'cross-family-contiguous-consensus';
  } else if (allBadgesResolved && familyLocalizationHealthy && !crossFamilyCountsAgree) {
    expectedHoleNumbers = Array.from({ length: resolvedLabels.length }, (_, index) => index + 1);
    completeness = {
      badge: 'complete',
      basket: fusedBaskets.length < resolvedLabels.length ? 'incomplete' : 'unknown'
    };
    completenessBasis = 'family-count-mismatch';
  }

  return {
    ...physical,
    completeness,
    expectedHoleNumbers,
    completenessBasis,
    badgeIdentities,
    badgeLabeling: {
      templateLoadMs: identity.templateLoadMs,
      pureTsMs: identity.pureTsMs,
      roiOpenCvMs: identity.roiOpenCvMs,
      roiOpenCvSourceCount: identity.roiOpenCvSourceCount,
      wholeRasterDiscoveryCount: identity.wholeRasterDiscoveryCount
    }
  };
}

/** Called only after `renderPipelineComposite` has sealed the exact output hash. */
export function recordRenderedSourceLandmarkEvidence(
  provenance: CompositeProvenance,
  batchHint: SemanticLandmarkBatchResult | null = peekLatestSemanticLandmarkBatch(),
  identityHint?: SourceBadgeIdentityBatch
): AnnotateSourceLandmarkEvidence | undefined {
  const signature = sourceSignature(provenance);
  let batch = batchesBySourceSignature.get(signature);
  if (!batch) {
    if (!batchHint || !exactBatchIdentity(batchHint, provenance)) return undefined;
    batch = batchHint;
    batchesBySourceSignature.set(signature, batch);
    capMap(batchesBySourceSignature);
  }
  if (identityHint && batchHint && exactBatchIdentity(batchHint, provenance)) {
    identitiesBySourceSignature.set(signature, identityHint);
    capMap(identitiesBySourceSignature);
  }
  const identity = identitiesBySourceSignature.get(signature);
  const physical = buildPhysicalSourceLandmarkEvidence(batch, provenance);
  const evidence = enrichEvidence(physical, batch, identity, provenance);
  evidenceByCompositeSha.set(provenance.finalRasterSha256, evidence);
  capMap(evidenceByCompositeSha);
  latestRenderedEvidence = evidence;
  return evidence;
}

export function sourceLandmarkEvidenceForCompositeSha(
  compositeSha256: string
): AnnotateSourceLandmarkEvidence | undefined {
  return evidenceByCompositeSha.get(compositeSha256);
}

/** Exact-byte lookup used at Annotate's existing detection seam. */
export async function sourceLandmarkEvidenceForRaster(
  bytes: Uint8Array
): Promise<AnnotateSourceLandmarkEvidence | undefined> {
  const sha = await sha256Hex(bytes);
  return evidenceByCompositeSha.get(sha);
}

/** Allows preload code to defer eager CV while exact source evidence exists. */
export function hasRenderedSourceLandmarkEvidence(): boolean {
  return latestRenderedEvidence !== null;
}

export function clearSourceLandmarkBridgeForTests(): void {
  batchesBySourceSignature.clear();
  identitiesBySourceSignature.clear();
  evidenceByCompositeSha.clear();
  latestRenderedEvidence = null;
}
