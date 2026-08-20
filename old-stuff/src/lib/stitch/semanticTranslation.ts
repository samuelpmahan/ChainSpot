import type { SemanticLandmark, SemanticLandmarkFamily, SemanticSourceLandmarks } from './semanticLandmarks';

export interface SemanticTranslationCorrespondence {
  readonly a: SemanticLandmark;
  readonly b: SemanticLandmark;
  readonly dxPx: number;
  readonly dyPx: number;
  readonly residualPx: number;
}

export interface SemanticTranslationHypothesis {
  readonly dxPx: number;
  readonly dyPx: number;
  readonly inlierCount: number;
  readonly familyDiversity: number;
  readonly families: readonly SemanticLandmarkFamily[];
  readonly rmsResidualPx: number;
  readonly correspondences: readonly SemanticTranslationCorrespondence[];
  readonly score: number;
}

export type SemanticTranslationAbstention =
  | 'no-compatible-landmarks'
  | 'insufficient-independent-support'
  | 'ambiguous-runner-up';

export interface SemanticTranslationResult {
  readonly ok: boolean;
  readonly translation: { readonly dxPx: number; readonly dyPx: number } | null;
  readonly winner: SemanticTranslationHypothesis | null;
  readonly runnerUp: SemanticTranslationHypothesis | null;
  readonly ambiguityMargin: number;
  readonly voteCount: number;
  readonly elapsedMs: number;
  readonly reason: SemanticTranslationAbstention | null;
}

export interface SemanticTranslationOptions {
  readonly clusterRadiusPx: number;
  readonly geometryRelTolerance: number;
  readonly minInliers: number;
  readonly minAmbiguityMargin: number;
}

export const SEMANTIC_TRANSLATION_DEFAULTS: SemanticTranslationOptions = Object.freeze({
  clusterRadiusPx: 3,
  geometryRelTolerance: 0.22,
  minInliers: 2,
  minAmbiguityMargin: 0.35
});

interface Vote {
  readonly a: SemanticLandmark;
  readonly b: SemanticLandmark;
  readonly dxPx: number;
  readonly dyPx: number;
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function relativeDifference(a: number, b: number): number {
  return Math.abs(a - b) / Math.max(1, Math.max(a, b));
}

function geometryCompatible(a: SemanticLandmark, b: SemanticLandmark, tolerance: number): boolean {
  return (
    relativeDifference(a.widthPx, b.widthPx) <= tolerance &&
    relativeDifference(a.heightPx, b.heightPx) <= tolerance &&
    relativeDifference(a.areaPx, b.areaPx) <= tolerance * 1.5
  );
}

function hypothesisScore(inliers: number, familyDiversity: number, rms: number, radius: number): number {
  return inliers + Math.max(0, familyDiversity - 1) * 0.35 - Math.min(1, rms / Math.max(1e-6, radius)) * 0.2;
}

function buildHypothesis(votes: readonly Vote[], seed: Vote, radiusPx: number): SemanticTranslationHypothesis {
  const radiusSq = radiusPx * radiusPx;
  let nearby = votes.filter((vote) => {
    const dx = vote.dxPx - seed.dxPx;
    const dy = vote.dyPx - seed.dyPx;
    return dx * dx + dy * dy <= radiusSq;
  });

  // Recenter once before enforcing one-to-one support. This keeps a noisy true
  // cluster together while repeated UI pairings that merely graze the seed
  // radius do not get to contribute multiple times through the same object.
  let centerX = nearby.reduce((sum, vote) => sum + vote.dxPx, 0) / Math.max(1, nearby.length);
  let centerY = nearby.reduce((sum, vote) => sum + vote.dyPx, 0) / Math.max(1, nearby.length);
  nearby = nearby
    .map((vote) => ({ vote, residual: Math.hypot(vote.dxPx - centerX, vote.dyPx - centerY) }))
    .sort((a, b) => a.residual - b.residual)
    .map((entry) => entry.vote);

  const usedA = new Set<SemanticLandmark>();
  const usedB = new Set<SemanticLandmark>();
  const independent: Vote[] = [];
  for (const vote of nearby) {
    if (usedA.has(vote.a) || usedB.has(vote.b)) continue;
    usedA.add(vote.a);
    usedB.add(vote.b);
    independent.push(vote);
  }

  centerX = independent.reduce((sum, vote) => sum + vote.dxPx, 0) / Math.max(1, independent.length);
  centerY = independent.reduce((sum, vote) => sum + vote.dyPx, 0) / Math.max(1, independent.length);
  const correspondences = independent.map((vote): SemanticTranslationCorrespondence => ({
    a: vote.a,
    b: vote.b,
    dxPx: vote.dxPx,
    dyPx: vote.dyPx,
    residualPx: Math.hypot(vote.dxPx - centerX, vote.dyPx - centerY)
  }));
  const rmsResidualPx = Math.sqrt(
    correspondences.reduce((sum, correspondence) => sum + correspondence.residualPx ** 2, 0) /
      Math.max(1, correspondences.length)
  );
  const families = [...new Set(correspondences.map((correspondence) => correspondence.a.family))].sort();
  return {
    dxPx: centerX,
    dyPx: centerY,
    inlierCount: correspondences.length,
    familyDiversity: families.length,
    families,
    rmsResidualPx,
    correspondences,
    score: hypothesisScore(correspondences.length, families.length, rmsResidualPx, radiusPx)
  };
}

function distinctHypotheses(hypotheses: readonly SemanticTranslationHypothesis[], radiusPx: number): SemanticTranslationHypothesis[] {
  const sorted = [...hypotheses].sort(
    (a, b) =>
      b.score - a.score ||
      b.inlierCount - a.inlierCount ||
      b.familyDiversity - a.familyDiversity ||
      a.rmsResidualPx - b.rmsResidualPx
  );
  const out: SemanticTranslationHypothesis[] = [];
  const separation = Math.max(radiusPx * 1.5, 1);
  for (const candidate of sorted) {
    if (out.some((kept) => Math.hypot(candidate.dxPx - kept.dxPx, candidate.dyPx - kept.dyPx) <= separation)) continue;
    out.push(candidate);
  }
  return out;
}

/**
 * Pairwise point-arithmetic stitch seed. Every same-family pair votes for
 * pA-pB. Correct shared physical objects collapse onto one offset; unrelated
 * repeated UI sprays votes elsewhere. No image rendering or OpenCV occurs.
 */
export function voteSemanticTranslation(
  a: SemanticSourceLandmarks,
  b: SemanticSourceLandmarks,
  overrides?: Partial<SemanticTranslationOptions>
): SemanticTranslationResult {
  const started = nowMs();
  const options: SemanticTranslationOptions = overrides
    ? { ...SEMANTIC_TRANSLATION_DEFAULTS, ...overrides }
    : SEMANTIC_TRANSLATION_DEFAULTS;
  const votes: Vote[] = [];
  for (const landmarkA of a.landmarks) {
    for (const landmarkB of b.landmarks) {
      if (landmarkA.family !== landmarkB.family) continue;
      if (!geometryCompatible(landmarkA, landmarkB, options.geometryRelTolerance)) continue;
      votes.push({
        a: landmarkA,
        b: landmarkB,
        dxPx: landmarkA.xPx - landmarkB.xPx,
        dyPx: landmarkA.yPx - landmarkB.yPx
      });
    }
  }
  if (votes.length === 0) {
    return {
      ok: false,
      translation: null,
      winner: null,
      runnerUp: null,
      ambiguityMargin: 0,
      voteCount: 0,
      elapsedMs: nowMs() - started,
      reason: 'no-compatible-landmarks'
    };
  }

  const ranked = distinctHypotheses(
    votes.map((vote) => buildHypothesis(votes, vote, options.clusterRadiusPx)),
    options.clusterRadiusPx
  );
  const winner = ranked[0] ?? null;
  const runnerUp = ranked[1] ?? null;
  const ambiguityMargin = winner ? winner.score - (runnerUp?.score ?? 0) : 0;
  let reason: SemanticTranslationAbstention | null = null;
  if (!winner || winner.inlierCount < options.minInliers) reason = 'insufficient-independent-support';
  else if (runnerUp && ambiguityMargin < options.minAmbiguityMargin) reason = 'ambiguous-runner-up';

  return {
    ok: reason === null,
    translation: reason === null && winner ? { dxPx: winner.dxPx, dyPx: winner.dyPx } : null,
    winner,
    runnerUp,
    ambiguityMargin,
    voteCount: votes.length,
    elapsedMs: nowMs() - started,
    reason
  };
}
