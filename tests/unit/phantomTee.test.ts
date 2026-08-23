import { describe, expect, it } from 'vitest';

import { recoverPredecessorBasketPhantomTees } from '../../src/lib/nuthing/phantomTee';

describe('recoverPredecessorBasketPhantomTees', () => {
  it('fills only still-missing Tn from B(n-1) and preserves measured evidence', () => {
    const tees = recoverPredecessorBasketPhantomTees(
      [1, 2, 3, 4],
      [
        { holeNumber: 1, xPx: 10, yPx: 20, kind: 'observed', appearance: 'observed' },
        { holeNumber: 3, xPx: 30, yPx: 40, kind: 'shard', appearance: 'partial' },
      ],
      [
        { holeNumber: 1, tipX: 100, tipY: 200 },
        { holeNumber: 2, tipX: 300, tipY: 400 },
      ],
    );

    expect(tees).toEqual([
      { holeNumber: 1, xPx: 10, yPx: 20, kind: 'observed', appearance: 'observed' },
      {
        holeNumber: 2,
        xPx: 100,
        yPx: 200,
        kind: 'phantom-predecessor-basket',
        appearance: 'unknown',
        predecessorBasketHoleNumber: 1,
      },
      { holeNumber: 3, xPx: 30, yPx: 40, kind: 'shard', appearance: 'partial' },
    ]);
  });
});
