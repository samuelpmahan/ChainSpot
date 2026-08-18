import { afterEach, describe, expect, test } from 'vitest';
import {
  CURRENT_PROVENANCE_SCHEMA_VERSION,
  CURRENT_RENDER_VERSION,
  applySourceTransform,
  translationSourceTransform,
  type CompositeProvenance,
  type SourceCapture
} from '../../src/lib/domain/provenance';
import type { SemanticLandmark, SemanticLandmarkBatchResult } from '../../src/lib/stitch/semanticLandmarks';
import type { SourceBadgeIdentityBatch } from '../../src/lib/autoAnnotation/sourceBadgeIdentity';
import {
  clearSourceLandmarkBridgeForTests,
  recordRenderedSourceLandmarkEvidence
} from '../../src/lib/autoAnnotation/sourceLandmarkBridge';
import { canUseSourcePriorCoursePath } from '../../src/lib/autoAnnotation/sourcePriorCourseDetection';

function capture(sourceId: string, sha: string, dxPx: number): SourceCapture {
  const transform = translationSourceTransform(dxPx, 0);
  const corners = [
    { xPx: 0, yPx: 0 },
    { xPx: 500, yPx: 0 },
    { xPx: 500, yPx: 400 },
    { xPx: 0, yPx: 400 }
  ];
  return {
    sourceId,
    fileName: `${sourceId}.png`,
    mimeType: 'image/png',
    widthPx: 500,
    heightPx: 400,
    sha256: sha,
    crop: { xPx: 0, yPx: 0, widthPx: 500, heightPx: 400 },
    transform,
    origin: { crop: 'auto', transform: 'auto' },
    coveragePolygon: corners.map((point) => applySourceTransform(point, transform)),
    paintOrder: dxPx === 0 ? 0 : 1
  };
}

function landmark(
  sourceId: string,
  family: 'badge' | 'basket',
  xPx: number,
  yPx: number
): SemanticLandmark {
  const badge = family === 'badge';
  return {
    sourceId,
    family,
    xPx,
    yPx,
    widthPx: badge ? 48 : 42,
    heightPx: badge ? 36 : 66,
    areaPx: badge ? 1500 : 1700,
    fill: badge ? 0.87 : 0.61
  };
}

function batch(missingBasket2 = false): SemanticLandmarkBatchResult {
  const source = (sourceId: string, dxPx: number) => {
    const landmarks: SemanticLandmark[] = [
      landmark(sourceId, 'badge', 100 - dxPx, 100),
      landmark(sourceId, 'basket', 100 - dxPx, 220),
      landmark(sourceId, 'badge', 300 - dxPx, 100)
    ];
    if (!missingBasket2) landmarks.push(landmark(sourceId, 'basket', 300 - dxPx, 220));
    return { sourceId, widthPx: 500, heightPx: 400, landmarks };
  };
  return {
    sources: [source('a', 0), source('b', 20)],
    scales: {
      badge: { family: 'badge', widthPx: 48, heightPx: 36, areaPx: 1500, support: 4, sourceSupport: 2 },
      basket: { family: 'basket', widthPx: 42, heightPx: 66, areaPx: 1700, support: missingBasket2 ? 2 : 4, sourceSupport: 2 }
    },
    diagnostics: {
      elapsedMs: 1,
      brightComponentCount: missingBasket2 ? 2 : 4,
      darkComponentCount: 4,
      badgeShapePoolCount: 4,
      basketShapePoolCount: missingBasket2 ? 2 : 4,
      badgeAbstention: null,
      basketAbstention: null
    }
  };
}

function identities(): SourceBadgeIdentityBatch {
  const source = (sourceId: string) => ({
    sourceId,
    classifications: [1, 2].map((label, badgeIndex) => ({
      badgeIndex,
      method: 'pure-ts' as const,
      label,
      bestLabel: label,
      bestScore: 0.95,
      runnerUpScore: 0.7,
      ambiguityMargin: 0.25,
      abstention: null,
      elapsedMs: 0.1
    }))
  });
  return {
    sources: [source('a'), source('b')],
    vocabularyLabels: [1, 2, 3],
    templateLoadMs: 2,
    pureTsMs: 0.4,
    roiOpenCvMs: 0,
    roiOpenCvSourceCount: 0,
    wholeRasterDiscoveryCount: 0
  };
}

function provenance(): CompositeProvenance {
  return {
    schemaVersion: CURRENT_PROVENANCE_SCHEMA_VERSION,
    renderVersion: CURRENT_RENDER_VERSION,
    outputWidthPx: 520,
    outputHeightPx: 400,
    compositingPolicy: 'stitch-ascending-bottom-right-v1',
    resampling: 'none',
    sources: [capture('a', 'a'.repeat(64), 0), capture('b', 'b'.repeat(64), 20)],
    overlaps: [{ a: 'a', b: 'b', kind: 'placement-edge', score: 0.99 }],
    finalRasterSha256: 'f'.repeat(64)
  };
}

afterEach(() => clearSourceLandmarkBridgeForTests());

describe('source landmark readiness', () => {
  test('cross-family + contiguous badge identity consensus makes the source-only Annotate path eligible', () => {
    const evidence = recordRenderedSourceLandmarkEvidence(provenance(), batch(), identities());
    expect(evidence).toBeDefined();
    expect(evidence?.expectedHoleNumbers).toEqual([1, 2]);
    expect(evidence?.completeness).toEqual({ badge: 'complete', basket: 'complete' });
    expect(evidence?.completenessBasis).toBe('cross-family-contiguous-consensus');
    expect(evidence?.badgeIdentities.map((identity) => identity.label)).toEqual([1, 2]);
    expect(evidence?.badgeLabeling?.wholeRasterDiscoveryCount).toBe(0);
    expect(canUseSourcePriorCoursePath(evidence)).toBe(true);
  });

  test('an explicitly missing basket fails closed to fallback', () => {
    const evidence = recordRenderedSourceLandmarkEvidence(provenance(), batch(true), identities());
    expect(evidence?.expectedHoleNumbers).toEqual([1, 2]);
    expect(evidence?.completeness.badge).toBe('complete');
    expect(evidence?.completeness.basket).toBe('incomplete');
    expect(evidence?.completenessBasis).toBe('family-count-mismatch');
    expect(canUseSourcePriorCoursePath(evidence)).toBe(false);
  });

  test('unknown identity/expected-set completeness never suppresses historical discovery', () => {
    const evidence = recordRenderedSourceLandmarkEvidence(provenance(), batch());
    expect(evidence?.expectedHoleNumbers).toBeNull();
    expect(evidence?.completeness).toEqual({ badge: 'unknown', basket: 'unknown' });
    expect(canUseSourcePriorCoursePath(evidence)).toBe(false);
  });
});
