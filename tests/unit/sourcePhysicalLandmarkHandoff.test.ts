import { afterEach, describe, expect, test } from 'vitest';
import {
  applySourceTransform,
  CURRENT_PROVENANCE_SCHEMA_VERSION,
  CURRENT_RENDER_VERSION,
  translationSourceTransform,
  type CompositeProvenance,
  type SourceCapture
} from '../../src/lib/domain/provenance';
import { sha256Hex } from '../../src/lib/imageIntake';
import type { SemanticLandmarkBatchResult } from '../../src/lib/stitch/semanticLandmarks';
import {
  buildPhysicalSourceLandmarkEvidence,
  type SourcePhysicalLandmarkEvidence
} from '../../src/lib/autoAnnotation/sourceLandmarkHandoff';
import {
  clearSourceLandmarkBridgeForTests,
  recordRenderedSourceLandmarkEvidence,
  sourceLandmarkEvidenceForRaster
} from '../../src/lib/autoAnnotation/sourceLandmarkBridge';

function capture(
  sourceId: string,
  sha256: string,
  dxPx: number,
  dyPx: number
): SourceCapture {
  const crop = { xPx: 0, yPx: 0, widthPx: 1000, heightPx: 800 };
  const transform = translationSourceTransform(dxPx, dyPx);
  const sourceCorners = [
    { xPx: 0, yPx: 0 },
    { xPx: 1000, yPx: 0 },
    { xPx: 1000, yPx: 800 },
    { xPx: 0, yPx: 800 }
  ];
  return {
    sourceId,
    fileName: `${sourceId}.png`,
    mimeType: 'image/png',
    widthPx: 1000,
    heightPx: 800,
    sha256,
    crop,
    transform,
    origin: { crop: 'auto', transform: 'auto' },
    coveragePolygon: sourceCorners.map((point) => applySourceTransform(point, transform)),
    paintOrder: sourceId.endsWith('b') || sourceId.endsWith('2') ? 1 : 0
  };
}

function batch(sourceIds: readonly [string, string]): SemanticLandmarkBatchResult {
  return {
    sources: [
      {
        sourceId: sourceIds[0],
        widthPx: 1000,
        heightPx: 800,
        landmarks: [
          {
            sourceId: sourceIds[0],
            family: 'basket',
            xPx: 100,
            yPx: 100,
            widthPx: 40,
            heightPx: 60,
            areaPx: 1200,
            fill: 0.5
          },
          {
            sourceId: sourceIds[0],
            family: 'badge',
            xPx: 300,
            yPx: 200,
            widthPx: 48,
            heightPx: 36,
            areaPx: 1500,
            fill: 0.87
          }
        ]
      },
      {
        sourceId: sourceIds[1],
        widthPx: 1000,
        heightPx: 800,
        landmarks: [
          {
            sourceId: sourceIds[1],
            family: 'basket',
            xPx: 80,
            yPx: 100,
            widthPx: 40,
            heightPx: 60,
            areaPx: 1200,
            fill: 0.5
          },
          {
            sourceId: sourceIds[1],
            family: 'badge',
            xPx: 280,
            yPx: 200,
            widthPx: 48,
            heightPx: 36,
            areaPx: 1500,
            fill: 0.87
          }
        ]
      }
    ],
    scales: {
      basket: {
        family: 'basket',
        widthPx: 40,
        heightPx: 60,
        areaPx: 1200,
        support: 2,
        sourceSupport: 2
      },
      badge: {
        family: 'badge',
        widthPx: 48,
        heightPx: 36,
        areaPx: 1500,
        support: 2,
        sourceSupport: 2
      }
    },
    diagnostics: {
      elapsedMs: 1,
      brightComponentCount: 2,
      darkComponentCount: 2,
      badgeShapePoolCount: 2,
      basketShapePoolCount: 2,
      badgeAbstention: null,
      basketAbstention: null
    }
  };
}

function provenance(
  sourceIds: readonly [string, string],
  finalRasterSha256 = 'f'.repeat(64)
): CompositeProvenance {
  const sources = [
    capture(sourceIds[0], 'a'.repeat(64), 0, 0),
    capture(sourceIds[1], 'b'.repeat(64), 20, 0)
  ];
  return {
    schemaVersion: CURRENT_PROVENANCE_SCHEMA_VERSION,
    renderVersion: CURRENT_RENDER_VERSION,
    outputWidthPx: 1020,
    outputHeightPx: 800,
    compositingPolicy: 'stitch-ascending-bottom-right-v1',
    resampling: 'none',
    sources,
    overlaps: [{ a: sourceIds[0], b: sourceIds[1], kind: 'placement-edge', score: 0.99 }],
    finalRasterSha256
  };
}

afterEach(() => clearSourceLandmarkBridgeForTests());

describe('physical source landmark handoff', () => {
  test('fuses repeated physical basket sprites while deriving semantic basket bottom only downstream', () => {
    const evidence = buildPhysicalSourceLandmarkEvidence(batch(['a', 'b']), provenance(['a', 'b']));
    const basket = evidence.fused.find((item) => item.family === 'basket');
    expect(basket).toBeDefined();
    expect(basket).toMatchObject({
      evidence: 'multi-source',
      observationCount: 2,
      rmsResidualPx: 0,
      spreadPx: 0,
      compositePoint: { xPx: 100, yPx: 100 },
      compositeSemanticPoint: { xPx: 100, yPx: 130 }
    });
    expect(basket?.observations[0].sourcePoint).toEqual({ xPx: 100, yPx: 100 });
    expect(basket?.observations[0].sourceSemanticPoint).toEqual({ xPx: 100, yPx: 130 });
    expect(evidence.completeness).toEqual({ badge: 'unknown', basket: 'unknown' });
  });

  test('rebinds observations to current final transforms when manual UI source ids changed', () => {
    const evidence = buildPhysicalSourceLandmarkEvidence(
      batch(['auto-a', 'auto-b']),
      provenance(['manual-1', 'manual-2'])
    );
    const basket = evidence.fused.find((item) => item.family === 'basket');
    expect(basket?.sourceIds).toEqual(['manual-1', 'manual-2']);
    expect(basket?.compositePoint).toEqual({ xPx: 100, yPx: 100 });
    expect(basket?.observations[1].sourceTransform.coefficients).toEqual([1, 0, 0, 1, 20, 0]);
  });

  test('exact composite bytes gate Annotate evidence reuse', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const finalHash = await sha256Hex(bytes);
    const recorded = recordRenderedSourceLandmarkEvidence(
      provenance(['a', 'b'], finalHash),
      batch(['a', 'b'])
    );
    expect(recorded).toBeDefined();
    const exact: SourcePhysicalLandmarkEvidence | undefined = await sourceLandmarkEvidenceForRaster(bytes);
    expect(exact?.compositeIdentity).toBe(finalHash);
    expect(await sourceLandmarkEvidenceForRaster(new Uint8Array([1, 2, 3, 4, 6]))).toBeUndefined();
  });
});
