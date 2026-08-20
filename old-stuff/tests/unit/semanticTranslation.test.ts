import { describe, expect, test } from 'vitest';
import { voteSemanticTranslation } from '../../src/lib/stitch/semanticTranslation';
import type { SemanticLandmark, SemanticSourceLandmarks } from '../../src/lib/stitch/semanticLandmarks';

function landmark(sourceId: string, family: 'badge' | 'basket', xPx: number, yPx: number): SemanticLandmark {
  return { sourceId, family, xPx, yPx, widthPx: 40, heightPx: 30, areaPx: 800, fill: 2 / 3 };
}
function source(sourceId: string, landmarks: SemanticLandmark[]): SemanticSourceLandmarks {
  return { sourceId, widthPx: 1000, heightPx: 1000, landmarks };
}

describe('semantic translation voting', () => {
  test('recovers a translation from independent same-offset correspondences while wrong repeated-UI pairings spray away', () => {
    const a = source('a', [
      landmark('a', 'badge', 100, 100),
      landmark('a', 'basket', 400, 500),
      landmark('a', 'badge', 700, 200)
    ]);
    const b = source('b', [
      landmark('b', 'badge', 80, 130),
      landmark('b', 'basket', 380, 530),
      landmark('b', 'badge', 680, 230)
    ]);
    const result = voteSemanticTranslation(a, b);
    expect(result.ok).toBe(true);
    expect(result.translation).toEqual({ dxPx: 20, dyPx: -30 });
    expect(result.winner?.inlierCount).toBe(3);
    expect(result.winner?.familyDiversity).toBe(2);
    expect(result.winner?.rmsResidualPx).toBe(0);
    expect(result.runnerUp?.inlierCount).toBeLessThan(result.winner?.inlierCount ?? 0);
  });

  test('one correspondence remains a hypothesis and abstains', () => {
    const a = source('a', [landmark('a', 'badge', 100, 100)]);
    const b = source('b', [landmark('b', 'badge', 80, 130)]);
    const result = voteSemanticTranslation(a, b);
    expect(result.ok).toBe(false);
    expect(result.winner?.inlierCount).toBe(1);
    expect(result.reason).toBe('insufficient-independent-support');
  });
});
