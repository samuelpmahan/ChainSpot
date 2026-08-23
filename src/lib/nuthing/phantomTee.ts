export type TeeEvidenceKind = 'observed' | 'shard' | 'phantom-predecessor-basket';

export interface LabeledTeeEvidence {
  holeNumber: number;
  xPx: number;
  yPx: number;
  kind: TeeEvidenceKind;
  /** Appearance is unmeasured for a fully occluded phantom tee. */
  appearance: 'observed' | 'partial' | 'unknown';
  predecessorBasketHoleNumber?: number;
}

export interface LabeledBasketEndpoint {
  holeNumber: number;
  tipX: number;
  tipY: number;
}

/**
 * Minimal C01 Complete Occlusion fallback.
 *
 * This deliberately does NOT infer ownership. The caller must first provide
 * the tee evidence it already trusts (intact + shard recovery) and labeled
 * basket endpoints. For every still-missing Tn, n > 1, synthesize the tee at
 * B(n-1)'s semantic pole tip. T1 and holes whose predecessor basket is absent
 * remain unresolved.
 *
 * Phantom evidence must never be fed back into the intact tee family or an
 * appearance model: its appearance is UNKNOWN by construction.
 */
export function recoverPredecessorBasketPhantomTees(
  holeNumbers: readonly number[],
  tees: readonly LabeledTeeEvidence[],
  baskets: readonly LabeledBasketEndpoint[],
): LabeledTeeEvidence[] {
  const byHole = new Map<number, LabeledTeeEvidence>();
  for (const tee of tees) byHole.set(tee.holeNumber, tee);
  const basketByHole = new Map(baskets.map((basket) => [basket.holeNumber, basket] as const));

  for (const holeNumber of [...holeNumbers].sort((a, b) => a - b)) {
    if (byHole.has(holeNumber) || holeNumber <= 1) continue;
    const predecessor = basketByHole.get(holeNumber - 1);
    if (!predecessor) continue;
    byHole.set(holeNumber, {
      holeNumber,
      xPx: predecessor.tipX,
      yPx: predecessor.tipY,
      kind: 'phantom-predecessor-basket',
      appearance: 'unknown',
      predecessorBasketHoleNumber: predecessor.holeNumber,
    });
  }

  return [...byHole.values()].sort((a, b) => a.holeNumber - b.holeNumber);
}
