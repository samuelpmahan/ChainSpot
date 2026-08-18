/**
 * Ephemeral Stitch Map -> Annotate Course evidence bridge (CHSPT-79).
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
import {
  buildPhysicalSourceLandmarkEvidence,
  type SourcePhysicalLandmarkEvidence
} from './sourceLandmarkHandoff';

const MAX_SESSION_ENTRIES = 16;
const batchesBySourceSignature = new Map<string, SemanticLandmarkBatchResult>();
const evidenceByCompositeSha = new Map<string, SourcePhysicalLandmarkEvidence>();
let latestRenderedEvidence: SourcePhysicalLandmarkEvidence | null = null;

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

/** Called only after `renderPipelineComposite` has sealed the exact output hash. */
export function recordRenderedSourceLandmarkEvidence(
  provenance: CompositeProvenance,
  batchHint: SemanticLandmarkBatchResult | null = peekLatestSemanticLandmarkBatch()
): SourcePhysicalLandmarkEvidence | undefined {
  const signature = sourceSignature(provenance);
  let batch = batchesBySourceSignature.get(signature);
  if (!batch) {
    if (!batchHint || !exactBatchIdentity(batchHint, provenance)) return undefined;
    batch = batchHint;
    batchesBySourceSignature.set(signature, batch);
    capMap(batchesBySourceSignature);
  }

  const evidence = buildPhysicalSourceLandmarkEvidence(batch, provenance);
  evidenceByCompositeSha.set(provenance.finalRasterSha256, evidence);
  capMap(evidenceByCompositeSha);
  latestRenderedEvidence = evidence;
  return evidence;
}

export function sourceLandmarkEvidenceForCompositeSha(
  compositeSha256: string
): SourcePhysicalLandmarkEvidence | undefined {
  return evidenceByCompositeSha.get(compositeSha256);
}

/** Exact-byte lookup used at Annotate's existing detection seam. */
export async function sourceLandmarkEvidenceForRaster(
  bytes: Uint8Array
): Promise<SourcePhysicalLandmarkEvidence | undefined> {
  const sha = await sha256Hex(bytes);
  return evidenceByCompositeSha.get(sha);
}

/**
 * Allows preload code to avoid eagerly warming CV while a rendered
 * source-evidence handoff is pending. Exact-byte matching still gates actual
 * reuse, so an unrelated image can at worst lose speculative warm-up time.
 */
export function hasRenderedSourceLandmarkEvidence(): boolean {
  return latestRenderedEvidence !== null;
}

export function clearSourceLandmarkBridgeForTests(): void {
  batchesBySourceSignature.clear();
  evidenceByCompositeSha.clear();
  latestRenderedEvidence = null;
}
