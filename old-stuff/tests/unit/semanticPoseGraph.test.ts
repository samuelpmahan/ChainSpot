import { describe, expect, test } from 'vitest';
import {
  buildSemanticPoseGraph,
  classifyCorrespondenceEvidence,
  fitMinimalSemanticTransform
} from '../../src/lib/stitch/semanticPoseGraph';
import type { SemanticLandmark, SemanticSourceLandmarks } from '../../src/lib/stitch/semanticLandmarks';
import type { SemanticTranslationCorrespondence } from '../../src/lib/stitch/semanticTranslation';

function landmark(sourceId: string, family: 'badge' | 'basket', xPx: number, yPx: number): SemanticLandmark {
  return { sourceId, family, xPx, yPx, widthPx: 40, heightPx: 30, areaPx: 800, fill: 2 / 3 };
}
function source(sourceId: string, dx: number, dy: number): SemanticSourceLandmarks {
  const globals = [
    ['badge', 100, 100], ['basket', 400, 500], ['badge', 700, 200], ['basket', 800, 700]
  ] as const;
  return {
    sourceId,
    widthPx: 1000,
    heightPx: 1000,
    landmarks: globals.map(([family, x, y]) => landmark(sourceId, family, x - dx, y - dy))
  };
}
function pair(a: SemanticLandmark, b: SemanticLandmark): SemanticTranslationCorrespondence {
  return { a, b, dxPx: a.xPx - b.xPx, dyPx: a.yPx - b.yPx, residualPx: 0 };
}

describe('semantic pose graph', () => {
  test('uses the existing poseGraph strongest-seed/maximum-weight-tree shape for arbitrary N translation edges', () => {
    const graph = buildSemanticPoseGraph([source('a', 0, 0), source('b', 120, -30), source('c', -80, 240)]);
    expect(graph.connected).toBe(true);
    expect(graph.placementEdges).toHaveLength(2);
    expect(graph.visitOrder).toHaveLength(3);
    expect(graph.transforms.size).toBe(3);
    expect(graph.pixelFallbackPairs).toEqual([]);
  });

  test('leaves a tile disconnected when no pair has two independent semantic correspondences', () => {
    const a = source('a', 0, 0);
    const b = source('b', 120, -30);
    const isolated: SemanticSourceLandmarks = {
      sourceId: 'isolated',
      widthPx: 1000,
      heightPx: 1000,
      landmarks: [landmark('isolated', 'badge', 50, 50)]
    };
    const graph = buildSemanticPoseGraph([a, b, isolated]);
    expect(graph.connected).toBe(false);
    expect(graph.visitOrder).toHaveLength(2);
    expect(graph.pixelFallbackPairs.some((edge) => edge.a === 0 && edge.b === 2)).toBe(true);
    expect(graph.pixelFallbackPairs.some((edge) => edge.a === 1 && edge.b === 2)).toBe(true);
  });

  test('codifies what 1/2/3 non-collinear correspondences identify without escalating needlessly', () => {
    const a1 = landmark('a', 'badge', 10, 10);
    const a2 = landmark('a', 'basket', 30, 10);
    const a3 = landmark('a', 'badge', 10, 30);
    const b1 = landmark('b', 'badge', 0, 0);
    const b2 = landmark('b', 'basket', 20, 0);
    const b3 = landmark('b', 'badge', 0, 20);
    const pairs = [pair(a1, b1), pair(a2, b2), pair(a3, b3)];
    expect(classifyCorrespondenceEvidence(pairs.slice(0, 1))).toMatchObject({ translationVerified: false, similarityIdentifiable: false, affineIdentifiable: false });
    expect(classifyCorrespondenceEvidence(pairs.slice(0, 2))).toMatchObject({ translationVerified: true, similarityIdentifiable: true, affineIdentifiable: false });
    expect(classifyCorrespondenceEvidence(pairs)).toMatchObject({ translationVerified: true, similarityIdentifiable: true, affineIdentifiable: true });
    expect(fitMinimalSemanticTransform(pairs)?.model).toBe('translation');
  });

  test('escalates to similarity with two points and affine with three only when translation/simple residual requires it', () => {
    const similarity = [
      pair(landmark('a', 'badge', 10, 10), landmark('b', 'badge', 0, 0)),
      pair(landmark('a', 'basket', 10, 30), landmark('b', 'basket', 10, 0))
    ];
    expect(fitMinimalSemanticTransform(similarity)?.model).toBe('similarity');

    const affine = [
      pair(landmark('a', 'badge', 5, 7), landmark('b', 'badge', 0, 0)),
      pair(landmark('a', 'basket', 25, 9), landmark('b', 'basket', 10, 0)),
      pair(landmark('a', 'badge', 8, 22), landmark('b', 'badge', 0, 10))
    ];
    expect(fitMinimalSemanticTransform(affine, 0.1)?.model).toBe('affine');
  });
});
