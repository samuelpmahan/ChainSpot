import type { SemanticSourceLandmarks } from './semanticLandmarks';
import {
  voteSemanticTranslation,
  type SemanticTranslationCorrespondence,
  type SemanticTranslationHypothesis,
  type SemanticTranslationOptions,
  type SemanticTranslationResult
} from './semanticTranslation';

export type SemanticAffine6 = readonly [number, number, number, number, number, number];
export type SemanticEvidenceModel = 'translation' | 'similarity' | 'affine';

export interface SemanticGraphEdge {
  readonly parent: number;
  readonly child: number;
  readonly coefficients: SemanticAffine6;
  readonly weight: number;
  readonly inlierCount: number;
  readonly familyDiversity: number;
  readonly rmsResidualPx: number;
  readonly ambiguityMargin: number;
  readonly correspondences: readonly SemanticTranslationCorrespondence[];
}

export interface SemanticPairProbe {
  readonly a: number;
  readonly b: number;
  readonly vote: SemanticTranslationResult;
  readonly edge: SemanticGraphEdge | null;
}

export interface SemanticPoseGraphResult {
  readonly pairProbes: readonly SemanticPairProbe[];
  readonly acceptedEdges: readonly SemanticGraphEdge[];
  readonly placementEdges: readonly SemanticGraphEdge[];
  readonly visitOrder: readonly number[];
  readonly transforms: ReadonlyMap<number, SemanticAffine6>;
  readonly connected: boolean;
  readonly pixelFallbackPairs: readonly { readonly a: number; readonly b: number; readonly reason: string }[];
  readonly elapsedMs: number;
}

export interface CorrespondenceEvidence {
  readonly count: number;
  readonly translationHypothesis: boolean;
  readonly translationVerified: boolean;
  readonly similarityIdentifiable: boolean;
  readonly affineIdentifiable: boolean;
  readonly nonCollinear: boolean;
}

export interface MinimalSemanticFit {
  readonly model: SemanticEvidenceModel;
  readonly coefficients: SemanticAffine6;
  readonly rmsResidualPx: number;
  readonly evidence: CorrespondenceEvidence;
  readonly verified: boolean;
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function translationCoefficients(dxPx: number, dyPx: number): SemanticAffine6 {
  return [1, 0, 0, 1, dxPx, dyPx];
}

function invertTranslation(coefficients: SemanticAffine6): SemanticAffine6 {
  return [1, 0, 0, 1, -coefficients[4], -coefficients[5]];
}

function composeAffine(outer: SemanticAffine6, inner: SemanticAffine6): SemanticAffine6 {
  const [A, B, C, D, E, F] = outer;
  const [a, b, c, d, e, f] = inner;
  return [
    A * a + C * b,
    B * a + D * b,
    A * c + C * d,
    B * c + D * d,
    A * e + C * f + E,
    B * e + D * f + F
  ];
}

function edgeWeight(winner: SemanticTranslationHypothesis, ambiguityMargin: number): number {
  // Preserve the same monotone signals the production graph already uses for
  // edge quality while keeping units semantic: independent support dominates,
  // two-family corroboration helps, residual hurts, and a clear runner-up gap
  // prevents repeated-UI ambiguity from looking strong.
  return (
    winner.inlierCount * 10 +
    winner.familyDiversity * 2 +
    Math.min(5, Math.max(0, ambiguityMargin)) -
    Math.min(5, winner.rmsResidualPx)
  );
}

function chooseSeed(n: number, weight: (i: number, j: number) => number): number {
  let seed = 0;
  let bestSum = -Infinity;
  for (let i = 0; i < n; i += 1) {
    let sum = 0;
    for (let j = 0; j < n; j += 1) {
      if (i === j) continue;
      const candidate = weight(i, j);
      if (Number.isFinite(candidate)) sum += candidate;
    }
    if (sum > bestSum) {
      bestSum = sum;
      seed = i;
    }
  }
  return seed;
}

/** Prim growth matching poseGraph.ts: strongest weighted seed, then strongest edge from placed to unplaced. */
function buildSpanningTree(
  n: number,
  weight: (i: number, j: number) => number
): { edges: Array<{ parent: number; child: number }>; visitOrder: number[] } {
  if (n === 0) return { edges: [], visitOrder: [] };
  const seed = chooseSeed(n, weight);
  const inTree = new Array<boolean>(n).fill(false);
  inTree[seed] = true;
  const visitOrder = [seed];
  const edges: Array<{ parent: number; child: number }> = [];
  while (visitOrder.length < n) {
    let bestParent = -1;
    let bestChild = -1;
    let bestWeight = -Infinity;
    for (const i of visitOrder) {
      for (let j = 0; j < n; j += 1) {
        if (inTree[j]) continue;
        const candidate = weight(i, j);
        if (candidate > bestWeight) {
          bestWeight = candidate;
          bestParent = i;
          bestChild = j;
        }
      }
    }
    if (bestChild === -1 || !Number.isFinite(bestWeight)) break;
    inTree[bestChild] = true;
    visitOrder.push(bestChild);
    edges.push({ parent: bestParent, child: bestChild });
  }
  return { edges, visitOrder };
}

/**
 * Diagnostic semantic edge supplier for the existing pose-graph architecture.
 * It does not mutate production stitching: all-pairs semantic edges are built,
 * weighted, and run through the same strongest-seed/maximum-weight-Prim shape
 * so we can measure exactly which edges could replace an OpenCV topology probe.
 */
export function buildSemanticPoseGraph(
  sources: readonly SemanticSourceLandmarks[],
  voteOptions?: Partial<SemanticTranslationOptions>
): SemanticPoseGraphResult {
  const started = nowMs();
  const pairProbes: SemanticPairProbe[] = [];
  const acceptedEdges: SemanticGraphEdge[] = [];
  const edgeByKey = new Map<string, SemanticGraphEdge>();

  for (let i = 0; i < sources.length; i += 1) {
    for (let j = i + 1; j < sources.length; j += 1) {
      const vote = voteSemanticTranslation(sources[i], sources[j], voteOptions);
      let edge: SemanticGraphEdge | null = null;
      if (vote.ok && vote.translation && vote.winner) {
        edge = {
          parent: i,
          child: j,
          coefficients: translationCoefficients(vote.translation.dxPx, vote.translation.dyPx),
          weight: edgeWeight(vote.winner, vote.ambiguityMargin),
          inlierCount: vote.winner.inlierCount,
          familyDiversity: vote.winner.familyDiversity,
          rmsResidualPx: vote.winner.rmsResidualPx,
          ambiguityMargin: vote.ambiguityMargin,
          correspondences: vote.winner.correspondences
        };
        acceptedEdges.push(edge);
        edgeByKey.set(`${i}:${j}`, edge);
      }
      pairProbes.push({ a: i, b: j, vote, edge });
    }
  }

  const weight = (i: number, j: number): number => {
    if (i === j) return -Infinity;
    const lo = Math.min(i, j);
    const hi = Math.max(i, j);
    return edgeByKey.get(`${lo}:${hi}`)?.weight ?? -Infinity;
  };
  const tree = buildSpanningTree(sources.length, weight);
  const transforms = new Map<number, SemanticAffine6>();
  const placementEdges: SemanticGraphEdge[] = [];
  if (tree.visitOrder.length > 0) transforms.set(tree.visitOrder[0], [1, 0, 0, 1, 0, 0]);

  for (const ref of tree.edges) {
    const lo = Math.min(ref.parent, ref.child);
    const hi = Math.max(ref.parent, ref.child);
    const stored = edgeByKey.get(`${lo}:${hi}`);
    if (!stored) continue;
    const relative = stored.parent === ref.parent ? stored.coefficients : invertTranslation(stored.coefficients);
    const parentTransform = transforms.get(ref.parent);
    if (!parentTransform) continue;
    transforms.set(ref.child, composeAffine(parentTransform, relative));
    placementEdges.push({ ...stored, parent: ref.parent, child: ref.child, coefficients: relative });
  }

  const pixelFallbackPairs = pairProbes
    .filter((probe) => !probe.vote.ok)
    .map((probe) => ({ a: probe.a, b: probe.b, reason: probe.vote.reason ?? 'semantic-edge-rejected' }));
  return {
    pairProbes,
    acceptedEdges,
    placementEdges,
    visitOrder: tree.visitOrder,
    transforms,
    connected: tree.visitOrder.length === sources.length,
    pixelFallbackPairs,
    elapsedMs: nowMs() - started
  };
}

export function classifyCorrespondenceEvidence(
  correspondences: readonly SemanticTranslationCorrespondence[],
  minSpreadPx = 3
): CorrespondenceEvidence {
  const count = correspondences.length;
  let maxBSpread = 0;
  for (let i = 0; i < count; i += 1) {
    for (let j = i + 1; j < count; j += 1) {
      maxBSpread = Math.max(
        maxBSpread,
        Math.hypot(
          correspondences[i].b.xPx - correspondences[j].b.xPx,
          correspondences[i].b.yPx - correspondences[j].b.yPx
        )
      );
    }
  }
  let nonCollinear = false;
  for (let i = 0; i < count && !nonCollinear; i += 1) {
    for (let j = i + 1; j < count && !nonCollinear; j += 1) {
      for (let k = j + 1; k < count; k += 1) {
        const p = correspondences[i].b;
        const q = correspondences[j].b;
        const r = correspondences[k].b;
        const twiceArea = Math.abs((q.xPx - p.xPx) * (r.yPx - p.yPx) - (q.yPx - p.yPx) * (r.xPx - p.xPx));
        if (twiceArea >= minSpreadPx * minSpreadPx) {
          nonCollinear = true;
          break;
        }
      }
    }
  }
  return {
    count,
    translationHypothesis: count >= 1,
    translationVerified: count >= 2,
    similarityIdentifiable: count >= 2 && maxBSpread >= minSpreadPx,
    affineIdentifiable: count >= 3 && nonCollinear,
    nonCollinear
  };
}

function apply(coefficients: SemanticAffine6, xPx: number, yPx: number): { xPx: number; yPx: number } {
  const [a, b, c, d, e, f] = coefficients;
  return { xPx: a * xPx + c * yPx + e, yPx: b * xPx + d * yPx + f };
}

function rms(coefficients: SemanticAffine6, correspondences: readonly SemanticTranslationCorrespondence[]): number {
  if (correspondences.length === 0) return Number.POSITIVE_INFINITY;
  return Math.sqrt(
    correspondences.reduce((sum, pair) => {
      const p = apply(coefficients, pair.b.xPx, pair.b.yPx);
      return sum + (p.xPx - pair.a.xPx) ** 2 + (p.yPx - pair.a.yPx) ** 2;
    }, 0) / correspondences.length
  );
}

function fitTranslation(correspondences: readonly SemanticTranslationCorrespondence[]): SemanticAffine6 {
  const dx = correspondences.reduce((sum, pair) => sum + pair.dxPx, 0) / Math.max(1, correspondences.length);
  const dy = correspondences.reduce((sum, pair) => sum + pair.dyPx, 0) / Math.max(1, correspondences.length);
  return translationCoefficients(dx, dy);
}

function fitSimilarity(correspondences: readonly SemanticTranslationCorrespondence[]): SemanticAffine6 | null {
  if (correspondences.length < 2) return null;
  let bestI = 0;
  let bestJ = 1;
  let bestSpan = -1;
  for (let i = 0; i < correspondences.length; i += 1) {
    for (let j = i + 1; j < correspondences.length; j += 1) {
      const dx = correspondences[j].b.xPx - correspondences[i].b.xPx;
      const dy = correspondences[j].b.yPx - correspondences[i].b.yPx;
      const span = dx * dx + dy * dy;
      if (span > bestSpan) {
        bestSpan = span;
        bestI = i;
        bestJ = j;
      }
    }
  }
  if (bestSpan <= 1e-9) return null;
  const p1 = correspondences[bestI];
  const p2 = correspondences[bestJ];
  const bx = p2.b.xPx - p1.b.xPx;
  const by = p2.b.yPx - p1.b.yPx;
  const ax = p2.a.xPx - p1.a.xPx;
  const ay = p2.a.yPx - p1.a.yPx;
  const bLen = Math.hypot(bx, by);
  const aLen = Math.hypot(ax, ay);
  if (bLen <= 1e-9) return null;
  const scale = aLen / bLen;
  const theta = Math.atan2(ay, ax) - Math.atan2(by, bx);
  const cos = Math.cos(theta) * scale;
  const sin = Math.sin(theta) * scale;
  const a = cos;
  const b = sin;
  const c = -sin;
  const d = cos;
  const e = p1.a.xPx - (a * p1.b.xPx + c * p1.b.yPx);
  const f = p1.a.yPx - (b * p1.b.xPx + d * p1.b.yPx);
  return [a, b, c, d, e, f];
}

function determinant3(m: readonly [readonly number[], readonly number[], readonly number[]]): number {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  );
}

function solve3(m: readonly [readonly number[], readonly number[], readonly number[]], y: readonly number[]): readonly [number, number, number] | null {
  const det = determinant3(m);
  if (Math.abs(det) <= 1e-9) return null;
  const replace = (col: number): [number[], number[], number[]] =>
    m.map((row, r) => row.map((value, c) => (c === col ? y[r] : value))) as [number[], number[], number[]];
  return [determinant3(replace(0)) / det, determinant3(replace(1)) / det, determinant3(replace(2)) / det];
}

function fitAffine3(correspondences: readonly SemanticTranslationCorrespondence[]): SemanticAffine6 | null {
  if (correspondences.length < 3) return null;
  for (let i = 0; i < correspondences.length; i += 1) {
    for (let j = i + 1; j < correspondences.length; j += 1) {
      for (let k = j + 1; k < correspondences.length; k += 1) {
        const chosen = [correspondences[i], correspondences[j], correspondences[k]] as const;
        const m = chosen.map((pair) => [pair.b.xPx, pair.b.yPx, 1]) as unknown as [number[], number[], number[]];
        const sx = solve3(m, chosen.map((pair) => pair.a.xPx));
        const sy = solve3(m, chosen.map((pair) => pair.a.yPx));
        if (sx && sy) return [sx[0], sy[0], sx[1], sy[1], sx[2], sy[2]];
      }
    }
  }
  return null;
}

/** Fit the simplest family first; only escalate when its measured residual requires it. */
export function fitMinimalSemanticTransform(
  correspondences: readonly SemanticTranslationCorrespondence[],
  residualThresholdPx = 2
): MinimalSemanticFit | null {
  if (correspondences.length === 0) return null;
  const evidence = classifyCorrespondenceEvidence(correspondences);
  const translation = fitTranslation(correspondences);
  const translationRms = rms(translation, correspondences);
  if (!evidence.translationVerified || translationRms <= residualThresholdPx) {
    return {
      model: 'translation',
      coefficients: translation,
      rmsResidualPx: translationRms,
      evidence,
      verified: evidence.translationVerified
    };
  }
  if (evidence.similarityIdentifiable) {
    const similarity = fitSimilarity(correspondences);
    if (similarity) {
      const similarityRms = rms(similarity, correspondences);
      if (!evidence.affineIdentifiable || similarityRms <= residualThresholdPx) {
        return { model: 'similarity', coefficients: similarity, rmsResidualPx: similarityRms, evidence, verified: true };
      }
    }
  }
  if (evidence.affineIdentifiable) {
    const affine = fitAffine3(correspondences);
    if (affine) return { model: 'affine', coefficients: affine, rmsResidualPx: rms(affine, correspondences), evidence, verified: true };
  }
  return { model: 'translation', coefficients: translation, rmsResidualPx: translationRms, evidence, verified: false };
}
