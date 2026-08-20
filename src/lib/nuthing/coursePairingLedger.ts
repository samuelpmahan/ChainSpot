/**
 * NuThing render-ledger closure pass.
 *
 * This wraps the frozen pair-matrix measurement instead of replacing it.
 * The existing paired-edge field remains the primary routing substrate; this
 * file only handles the renderer cases where the symmetry assumption is
 * known to be false or misleading:
 *
 *  - a badge / basket sprite covers one corridor flank;
 *  - bright-vs-dark underlay makes the two valid ribbon edges have opposite
 *    signed lift (the Rec tree-line RibbonExit family);
 *  - a narrow linear distractor such as the BTD walking path looks like a
 *    plausible paired strip but does not exhibit corridor-width paint lift;
 *  - a tee is physically present under known UI furniture and the normal
 *    hollow-glyph detector cannot close its outline.
 *
 * The deliberately crude course calibration is a four-bin luma -> signed
 * ribbon-lift table learned from only geometry-self-consistent straight
 * triples. No terrain classifier and no alpha inversion are required.
 */

import {
  backtrack,
  dijkstraFrom,
  FIELD_SCALE,
  SUPPORT_TAU,
  WORST_WINDOW_SRC_PX,
  measureCoursePairs as measureBaseCoursePairs,
  type BadgeMatrix,
  type CourseBasketPoint,
  type CoursePairingInputs,
  type CoursePairingResult,
  type CourseTeePoint,
  type LegEvidence,
  type PairEvidence,
} from './coursePairing';
import { buildSupportCost } from '../autoAnnotation/middleOutRibbon';
import {
  findOccludedTeePadMatch,
  type TeeOcclusionBadgeBox,
} from '../autoAnnotation/teeOcclusionRecovery';
import type { RgbaImage } from './raster';
import type { SupportField } from './ribbon';

const BUCKET_COUNT = 4;
const BUCKET_WIDTH = 64;
const EDGE_DELTA_PX = 2.5;
const MIN_BUCKET_COUNT = 5;
const MIN_MODEL_SAMPLES = 24;
const STRAIGHT_AXIS_MAX_DEG = 4;
const STRAIGHT_RAY_MAX_DEG = 1.8;
const STRAIGHT_FRAC_MIN = 0.16;
const STRAIGHT_FRAC_MAX = 0.56;
const GAP_LOW_SUPPORT = 0.18;
const GAP_HEALTHY_SUPPORT = 0.28;
const GAP_MAX_LOOK_FIELD = 3;
const GAP_EDGE_SCORE_MIN = 0.65;
const GAP_SUPPORT_CAP = 0.55;
const OCCLUDER_EDGE_SCORE_MIN = 0.65;
const OCCLUDER_SUPPORT_CAP = 0.72;
const RUNTIME_TEE_SCORE_MIN = 0.82;
const RUNTIME_TEE_DEDUPE_PX = 14;
const WALKING_CONSISTENCY_FLOOR = 0.8;

interface LiftBucket {
  readonly count: number;
  readonly mean: number;
  readonly mad: number;
}

export interface RibbonLiftModel {
  readonly buckets: readonly LiftBucket[];
  readonly global: LiftBucket;
  readonly straightTriples: number;
  readonly sampleCount: number;
}

interface OccluderBox extends TeeOcclusionBadgeBox {
  readonly kind: 'badge' | 'basket';
}

export interface RenderLedgerStats {
  readonly straightCalibrationTriples: number;
  readonly calibrationSamples: number;
  readonly bucketCounts: readonly number[];
  readonly bucketMeanLift: readonly number[];
  readonly signedOccluderPatchedCells: number;
  readonly contrastGapPatchedCells: number;
  readonly consistencyDiscountedCells: number;
  readonly runtimeRecoveredTees: number;
  readonly rerouted: boolean;
}

export interface CoursePairingLedgerResult extends CoursePairingResult {
  readonly ledgerStats: RenderLedgerStats;
}

function luma(image: RgbaImage, x: number, y: number): number | null {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= image.width || yi >= image.height) return null;
  const p = (yi * image.width + xi) * 4;
  return 0.299 * image.data[p] + 0.587 * image.data[p + 1] + 0.114 * image.data[p + 2];
}

function insideBox(box: TeeOcclusionBadgeBox, x: number, y: number, margin = 0): boolean {
  return (
    Math.abs(x - box.xPx) <= box.widthPx / 2 + margin &&
    Math.abs(y - box.yPx) <= box.heightPx / 2 + margin
  );
}

function insideAnyBox(boxes: readonly TeeOcclusionBadgeBox[], x: number, y: number, margin = 0): boolean {
  return boxes.some((box) => insideBox(box, x, y, margin));
}

function axisErrorRad(axis: number, dx: number, dy: number): number {
  if (Math.abs(dx) + Math.abs(dy) < 1e-9) return Math.PI / 2;
  let d = Math.abs(Math.atan2(dy, dx) - axis) % Math.PI;
  if (d > Math.PI / 2) d = Math.PI - d;
  return d;
}

function directedAngleRad(ax: number, ay: number, bx: number, by: number): number {
  const an = Math.hypot(ax, ay);
  const bn = Math.hypot(bx, by);
  if (an < 1e-9 || bn < 1e-9) return Math.PI;
  const c = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (an * bn)));
  return Math.acos(c);
}

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

function bucketStats(values: readonly number[]): LiftBucket {
  const m = mean(values);
  const med = median(values);
  return {
    count: values.length,
    mean: m,
    mad: median(values.map((v) => Math.abs(v - med))),
  };
}

function bucketIndex(outsideLuma: number): number {
  return Math.max(0, Math.min(BUCKET_COUNT - 1, Math.floor(outsideLuma / BUCKET_WIDTH)));
}

function edgeAgreement(model: RibbonLiftModel, outside: number, inside: number): number {
  const candidate = model.buckets[bucketIndex(outside)];
  const stats = candidate.count >= MIN_BUCKET_COUNT ? candidate : model.global;
  const observed = inside - outside;
  const sigma = Math.max(8, stats.mad * 1.4826, Math.abs(stats.mean) * 0.35);
  const z = Math.abs(observed - stats.mean) / sigma;
  return Math.exp(-0.5 * z * z);
}

function edgeScoresAt(
  image: RgbaImage,
  model: RibbonLiftModel,
  x: number,
  y: number,
  theta: number,
  corridorWidthPx: number,
): [number, number] | null {
  const nx = -Math.sin(theta);
  const ny = Math.cos(theta);
  const half = corridorWidthPx / 2;
  const li = luma(image, x - nx * (half - EDGE_DELTA_PX), y - ny * (half - EDGE_DELTA_PX));
  const lo = luma(image, x - nx * (half + EDGE_DELTA_PX), y - ny * (half + EDGE_DELTA_PX));
  const ri = luma(image, x + nx * (half - EDGE_DELTA_PX), y + ny * (half - EDGE_DELTA_PX));
  const ro = luma(image, x + nx * (half + EDGE_DELTA_PX), y + ny * (half + EDGE_DELTA_PX));
  if (li === null || lo === null || ri === null || ro === null) return null;
  return [edgeAgreement(model, lo, li), edgeAgreement(model, ro, ri)];
}

function learnLiftModel(
  image: RgbaImage,
  result: CoursePairingResult,
  corridorWidthPx: number,
  occluders: readonly OccluderBox[],
): RibbonLiftModel | null {
  const samples: number[][] = Array.from({ length: BUCKET_COUNT }, () => []);
  let straightTriples = 0;
  const usedTee = new Set<number>();
  const usedBasket = new Set<number>();
  const labeled = result.readings.filter((r) => r.label);
  const maxRay = (STRAIGHT_RAY_MAX_DEG * Math.PI) / 180;
  const maxAxis = (STRAIGHT_AXIS_MAX_DEG * Math.PI) / 180;

  for (const reading of labeled) {
    const badge = reading.badge;
    const candidates: Array<{ ti: number; bi: number; quality: number }> = [];
    for (let ti = 0; ti < result.teePoints.length; ti++) {
      const tee = result.teePoints[ti];
      if (tee.tier !== 'ring' || tee.angle === null) continue;
      const dbx = badge.cx - tee.x;
      const dby = badge.cy - tee.y;
      const axis = axisErrorRad(tee.angle, dbx, dby);
      if (axis > maxAxis) continue;
      for (let bi = 0; bi < result.basketPoints.length; bi++) {
        const basket = result.basketPoints[bi];
        if (basket.score < 0.45) continue;
        const vx = basket.x - tee.x;
        const vy = basket.y - tee.y;
        const ll = vx * vx + vy * vy;
        if (ll < 1) continue;
        const frac = (dbx * vx + dby * vy) / ll;
        if (frac < STRAIGHT_FRAC_MIN || frac > STRAIGHT_FRAC_MAX) continue;
        const ray = directedAngleRad(dbx, dby, vx, vy);
        if (ray > maxRay) continue;
        const perp = Math.abs(dbx * vy - dby * vx) / Math.sqrt(ll);
        if (perp > Math.max(5, corridorWidthPx * 0.16)) continue;
        candidates.push({
          ti,
          bi,
          quality: axis * 20 + ray * 30 + perp / Math.max(corridorWidthPx, 1) - basket.score * 0.15,
        });
      }
    }
    candidates.sort((a, b) => a.quality - b.quality);
    const best = candidates[0];
    if (!best) continue;
    if (candidates[1] && candidates[1].quality - best.quality < 0.035) continue;
    if (usedTee.has(best.ti) || usedBasket.has(best.bi)) continue;
    usedTee.add(best.ti);
    usedBasket.add(best.bi);
    straightTriples++;

    const tee = result.teePoints[best.ti];
    const basket = result.basketPoints[best.bi];
    const vx = basket.x - tee.x;
    const vy = basket.y - tee.y;
    const length = Math.hypot(vx, vy);
    if (length < 80) continue;
    const ux = vx / length;
    const uy = vy / length;
    const nx = -uy;
    const ny = ux;
    const half = corridorWidthPx / 2;
    const step = Math.max(8, corridorWidthPx / 2);
    const badgeBox: TeeOcclusionBadgeBox = {
      xPx: badge.cx,
      yPx: badge.cy,
      widthPx: badge.bboxW,
      heightPx: badge.bboxH,
    };

    for (let along = Math.max(20, corridorWidthPx); along <= length - Math.max(95, corridorWidthPx * 2.4); along += step) {
      const cx = tee.x + ux * along;
      const cy = tee.y + uy * along;
      if (insideBox(badgeBox, cx, cy, 22)) continue;
      for (const sign of [-1, 1] as const) {
        const ix = cx + sign * nx * (half - EDGE_DELTA_PX);
        const iy = cy + sign * ny * (half - EDGE_DELTA_PX);
        const ox = cx + sign * nx * (half + EDGE_DELTA_PX);
        const oy = cy + sign * ny * (half + EDGE_DELTA_PX);
        if (insideAnyBox(occluders, ix, iy, 2) || insideAnyBox(occluders, ox, oy, 2)) continue;
        const inside = luma(image, ix, iy);
        const outside = luma(image, ox, oy);
        if (inside === null || outside === null) continue;
        samples[bucketIndex(outside)].push(inside - outside);
      }
    }
  }

  const flat = samples.flat();
  if (flat.length < MIN_MODEL_SAMPLES) return null;
  return {
    buckets: samples.map(bucketStats),
    global: bucketStats(flat),
    straightTriples,
    sampleCount: flat.length,
  };
}

function patchSignedKnownOccluders(
  field: SupportField,
  image: RgbaImage,
  model: RibbonLiftModel,
  boxes: readonly OccluderBox[],
  corridorWidthPx: number,
): number {
  const snapshot = new Float32Array(field.support);
  const half = corridorWidthPx / 2;
  const reach = half + 7;
  let patched = 0;
  const isBlocked = (x: number, y: number): boolean => boxes.some((b) => insideBox(b, x, y, 2));
  const inBadgeCenter = (x: number, y: number): boolean =>
    boxes.some((b) => b.kind === 'badge' && insideBox(b, x, y, 3));

  for (const box of boxes) {
    const fx0 = Math.max(0, Math.floor((box.xPx - box.widthPx / 2 - reach) / field.scale));
    const fx1 = Math.min(field.width - 1, Math.ceil((box.xPx + box.widthPx / 2 + reach) / field.scale));
    const fy0 = Math.max(0, Math.floor((box.yPx - box.heightPx / 2 - reach) / field.scale));
    const fy1 = Math.min(field.height - 1, Math.ceil((box.yPx + box.heightPx / 2 + reach) / field.scale));
    for (let fy = fy0; fy <= fy1; fy++) {
      for (let fx = fx0; fx <= fx1; fx++) {
        const sx = fx * field.scale + field.scale / 2;
        const sy = fy * field.scale + field.scale / 2;
        if (inBadgeCenter(sx, sy)) continue; // preserve the measured halo cap
        let best = 0;
        let bestTheta = field.bestTheta[fy * field.width + fx];
        for (let o = 0; o < 24; o++) {
          const theta = (o * Math.PI) / 24;
          const nx = -Math.sin(theta);
          const ny = Math.cos(theta);
          const pts = [
            [sx - nx * (half - EDGE_DELTA_PX), sy - ny * (half - EDGE_DELTA_PX)],
            [sx - nx * (half + EDGE_DELTA_PX), sy - ny * (half + EDGE_DELTA_PX)],
            [sx + nx * (half - EDGE_DELTA_PX), sy + ny * (half - EDGE_DELTA_PX)],
            [sx + nx * (half + EDGE_DELTA_PX), sy + ny * (half + EDGE_DELTA_PX)],
          ];
          const leftBlocked = isBlocked(pts[0][0], pts[0][1]) || isBlocked(pts[1][0], pts[1][1]);
          const rightBlocked = isBlocked(pts[2][0], pts[2][1]) || isBlocked(pts[3][0], pts[3][1]);
          if (leftBlocked === rightBlocked) continue;
          const io = leftBlocked ? [2, 3] : [0, 1];
          const inside = luma(image, pts[io[0]][0], pts[io[0]][1]);
          const outside = luma(image, pts[io[1]][0], pts[io[1]][1]);
          if (inside === null || outside === null) continue;
          const score = edgeAgreement(model, outside, inside);
          if (score > best) {
            best = score;
            bestTheta = theta;
          }
        }
        if (best < OCCLUDER_EDGE_SCORE_MIN) continue;
        const i = fy * field.width + fx;
        const proposal = Math.min(OCCLUDER_SUPPORT_CAP, 0.38 + 0.42 * best);
        if (proposal > snapshot[i] + 1e-6 && proposal > field.support[i]) {
          field.support[i] = proposal;
          field.bestTheta[i] = bestTheta;
          patched++;
        }
      }
    }
  }
  return patched;
}

function healthyAlong(
  support: Float32Array,
  field: SupportField,
  fx: number,
  fy: number,
  theta: number,
  sign: -1 | 1,
): boolean {
  const ux = Math.cos(theta);
  const uy = Math.sin(theta);
  for (let step = 1; step <= GAP_MAX_LOOK_FIELD; step++) {
    const x = Math.round(fx + sign * ux * step);
    const y = Math.round(fy + sign * uy * step);
    if (x < 0 || y < 0 || x >= field.width || y >= field.height) continue;
    if (support[y * field.width + x] >= GAP_HEALTHY_SUPPORT) return true;
  }
  return false;
}

function patchShortContrastGaps(
  field: SupportField,
  image: RgbaImage,
  model: RibbonLiftModel,
  corridorWidthPx: number,
  occluders: readonly OccluderBox[],
): number {
  const before = new Float32Array(field.support);
  let patched = 0;
  for (let fy = 1; fy < field.height - 1; fy++) {
    for (let fx = 1; fx < field.width - 1; fx++) {
      const i = fy * field.width + fx;
      if (before[i] >= GAP_LOW_SUPPORT) continue;
      const sx = fx * field.scale + field.scale / 2;
      const sy = fy * field.scale + field.scale / 2;
      if (insideAnyBox(occluders, sx, sy, 3)) continue;

      let anchor = -1;
      let anchorSupport = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (dx === 0 && dy === 0) continue;
          const ni = (fy + dy) * field.width + fx + dx;
          if (before[ni] > anchorSupport) {
            anchorSupport = before[ni];
            anchor = ni;
          }
        }
      }
      if (anchor < 0 || anchorSupport < GAP_HEALTHY_SUPPORT) continue;
      const theta = field.bestTheta[anchor];
      if (!healthyAlong(before, field, fx, fy, theta, -1) || !healthyAlong(before, field, fx, fy, theta, 1)) continue;
      const scores = edgeScoresAt(image, model, sx, sy, theta, corridorWidthPx);
      if (!scores) continue;
      const score = Math.max(scores[0], scores[1]); // one good flank is enough
      if (score < GAP_EDGE_SCORE_MIN) continue;
      const proposal = Math.min(GAP_SUPPORT_CAP, 0.30 + 0.30 * score);
      if (proposal > field.support[i]) {
        field.support[i] = proposal;
        field.bestTheta[i] = theta;
        patched++;
      }
    }
  }
  return patched;
}

function recoverRuntimeOccludedTees(
  image: RgbaImage,
  result: CoursePairingResult,
  boxes: readonly OccluderBox[],
  corridorWidthPx: number,
): CourseTeePoint[] {
  const out: CourseTeePoint[] = [];
  const sizes = [18, 22, 26, 30, 34];
  const existing = [...result.teePoints];
  const centers = boxes.filter((b) => b.kind === 'basket' || b.kind === 'badge');
  for (const target of centers) {
    const match = findOccludedTeePadMatch(
      { rgba: image.data, widthPx: image.width, heightPx: image.height },
      target.xPx,
      target.yPx,
      Math.max(28, corridorWidthPx),
      sizes,
      boxes,
      [],
    );
    if (!match || match.score < RUNTIME_TEE_SCORE_MIN) continue;
    const dx = Math.max(0, Math.abs(match.xPx - target.xPx) - target.widthPx / 2);
    const dy = Math.max(0, Math.abs(match.yPx - target.yPx) - target.heightPx / 2);
    if (Math.hypot(dx, dy) > match.majorPx * 0.45) continue; // it must actually touch the occluder
    if (existing.some((t) => Math.hypot(t.x - match.xPx, t.y - match.yPx) < RUNTIME_TEE_DEDUPE_PX)) continue;
    if (out.some((t) => Math.hypot(t.x - match.xPx, t.y - match.yPx) < RUNTIME_TEE_DEDUPE_PX)) continue;
    out.push({
      x: match.xPx,
      y: match.yPx,
      tier: 'recovered',
      angle: (match.orientationDeg * Math.PI) / 180,
      onRing: result.basketPoints.some((b) => Math.abs(Math.hypot(match.xPx - b.x, match.yPx - b.y) - 84) <= 12),
    });
  }
  return out;
}

function discountNonCorridorLinearSupport(
  field: SupportField,
  image: RgbaImage,
  model: RibbonLiftModel,
  corridorWidthPx: number,
  boxes: readonly OccluderBox[],
  baskets: readonly CourseBasketPoint[],
): number {
  let changed = 0;
  for (let fy = 0; fy < field.height; fy++) {
    for (let fx = 0; fx < field.width; fx++) {
      const i = fy * field.width + fx;
      const s = field.support[i];
      if (s < 0.25) continue;
      const x = fx * field.scale + field.scale / 2;
      const y = fy * field.scale + field.scale / 2;
      if (insideAnyBox(boxes, x, y, 6)) continue;
      // Basket furniture already has explicit ownership-aware treatment in
      // pairScoring. Do not double-tax C1/C2/C2F here.
      if (baskets.some((b) => Math.hypot(x - b.x, y - b.y) <= 100)) continue;
      const scores = edgeScoresAt(image, model, x, y, field.bestTheta[i], corridorWidthPx);
      if (!scores) continue;
      const consistency = Math.max(scores[0], scores[1]);
      const factor = WALKING_CONSISTENCY_FLOOR + (1 - WALKING_CONSISTENCY_FLOOR) * consistency;
      if (factor < 0.995) {
        field.support[i] = s * factor;
        changed++;
      }
    }
  }
  return changed;
}

function clampCell(value: number, hi: number): number {
  return Math.max(0, Math.min(hi - 1, Math.round(value)));
}

function legFor(
  id: string,
  x: number,
  y: number,
  dist: Float64Array,
  prev: Int32Array,
  field: SupportField,
): LegEvidence {
  const gx = clampCell(x / field.scale, field.width);
  const gy = clampCell(y / field.scale, field.height);
  const goal = gy * field.width + gx;
  const reachable = Number.isFinite(dist[goal]);
  const cells = reachable ? backtrack(prev, goal) : new Int32Array(0);
  const path: number[] = [];
  for (const c of cells) path.push(c % field.width, (c - (c % field.width)) / field.width);
  return { endpointId: id, geodesic: reachable ? dist[goal] : Infinity, path, reachable };
}

function buildPair(
  courseName: string,
  label: string,
  ti: number,
  bi: number,
  tl: LegEvidence,
  bl: LegEvidence,
  tees: readonly CourseTeePoint[],
  baskets: readonly CourseBasketPoint[],
  field: SupportField,
): PairEvidence {
  const pairId = `${courseName}:h${label}:T${ti}:B${bi}`;
  if (!tl.reachable || !bl.reachable) {
    return {
      pairId, teeId: `T${ti}`, basketId: `B${bi}`,
      totalScore: Infinity, supportMean: 0, supportMin: 0, supportedFraction: 0,
      worstWindowMean: 0, weakSpanCount: 0, weakSpanLongestPx: 0,
      pathLengthPx: 0, straightDistancePx: 0, efficiency: 0,
      endpointSupportTee: 0, endpointSupportBasket: 0, failureReason: 'unreachable',
    };
  }
  const nT = tl.path.length / 2;
  const nB = bl.path.length / 2;
  const count = nT + nB - 1;
  const samples = new Float32Array(count);
  let lengthCells = 0;
  let px = -1;
  let py = -1;
  for (let s = 0; s < count; s++) {
    let x: number;
    let y: number;
    if (s < nT) {
      const j = (nT - 1 - s) * 2;
      x = tl.path[j];
      y = tl.path[j + 1];
    } else {
      const j = (s - nT + 1) * 2;
      x = bl.path[j];
      y = bl.path[j + 1];
    }
    samples[s] = field.support[y * field.width + x];
    if (px >= 0) lengthCells += Math.hypot(x - px, y - py);
    px = x;
    py = y;
  }
  let sum = 0;
  let minSupport = 1;
  let supported = 0;
  for (const s of samples) {
    sum += s;
    minSupport = Math.min(minSupport, s);
    if (s >= SUPPORT_TAU) supported++;
  }
  let weakSpanCount = 0;
  let weakSpanLongest = 0;
  let run = 0;
  for (let s = 0; s <= samples.length; s++) {
    if (s < samples.length && samples[s] < SUPPORT_TAU) run++;
    else if (run) {
      weakSpanCount++;
      weakSpanLongest = Math.max(weakSpanLongest, run);
      run = 0;
    }
  }
  const windowCells = Math.max(3, Math.round(WORST_WINDOW_SRC_PX / field.scale));
  let worstWindowMean = sum / Math.max(samples.length, 1);
  if (samples.length > windowCells) {
    let acc = 0;
    for (let i = 0; i < windowCells; i++) acc += samples[i];
    worstWindowMean = acc / windowCells;
    for (let i = windowCells; i < samples.length; i++) {
      acc += samples[i] - samples[i - windowCells];
      worstWindowMean = Math.min(worstWindowMean, acc / windowCells);
    }
  }
  const pathLengthPx = lengthCells * field.scale;
  const straightDistancePx = Math.hypot(baskets[bi].x - tees[ti].x, baskets[bi].y - tees[ti].y);
  const teeCell = clampCell(tees[ti].y / field.scale, field.height) * field.width + clampCell(tees[ti].x / field.scale, field.width);
  const basketCell = clampCell(baskets[bi].y / field.scale, field.height) * field.width + clampCell(baskets[bi].x / field.scale, field.width);
  return {
    pairId,
    teeId: `T${ti}`,
    basketId: `B${bi}`,
    totalScore: tl.geodesic + bl.geodesic,
    supportMean: sum / Math.max(samples.length, 1),
    supportMin: minSupport,
    supportedFraction: supported / Math.max(samples.length, 1),
    worstWindowMean,
    weakSpanCount,
    weakSpanLongestPx: weakSpanLongest * field.scale,
    pathLengthPx,
    straightDistancePx,
    efficiency: pathLengthPx / Math.max(straightDistancePx, 1e-6),
    endpointSupportTee: field.support[teeCell],
    endpointSupportBasket: field.support[basketCell],
    failureReason: null,
  };
}

function rebuildMatrices(
  courseName: string,
  result: CoursePairingResult,
  teePoints: readonly CourseTeePoint[],
  basketPoints: readonly CourseBasketPoint[],
  routeSupport: Float32Array,
  reroute: boolean,
): BadgeMatrix[] {
  const routeField: SupportField = { ...result.field, support: routeSupport };
  const cost = reroute ? buildSupportCost(routeSupport) : null;
  const oldByLabel = new Map(result.matrices.map((m) => [m.label, m]));
  const out: BadgeMatrix[] = [];
  for (const reading of result.readings) {
    if (!reading.label) continue;
    const label = reading.label;
    let teeLegs: LegEvidence[];
    let basketLegs: LegEvidence[];
    let routeMs = oldByLabel.get(label)?.routeMs ?? 0;
    if (reroute || !oldByLabel.has(label)) {
      const bx = clampCell(reading.badge.cx / routeField.scale, routeField.width);
      const by = clampCell(reading.badge.cy / routeField.scale, routeField.height);
      const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const { dist, prev } = dijkstraFrom(cost as Float32Array, routeField.width, routeField.height, bx, by);
      teeLegs = teePoints.map((p, i) => legFor(`T${i}`, p.x, p.y, dist, prev, routeField));
      basketLegs = basketPoints.map((p, i) => legFor(`B${i}`, p.x, p.y, dist, prev, routeField));
      routeMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started;
    } else {
      const old = oldByLabel.get(label) as BadgeMatrix;
      teeLegs = old.legs.filter((l) => l.endpointId.startsWith('T'));
      basketLegs = old.legs.filter((l) => l.endpointId.startsWith('B'));
    }
    const pairs: PairEvidence[] = [];
    for (let ti = 0; ti < teePoints.length; ti++) {
      for (let bi = 0; bi < basketPoints.length; bi++) {
        pairs.push(buildPair(courseName, label, ti, bi, teeLegs[ti], basketLegs[bi], teePoints, basketPoints, result.field));
      }
    }
    const rankOrder = pairs
      .map((_, i) => i)
      .sort((a, b) => pairs[b].worstWindowMean - pairs[a].worstWindowMean || pairs[b].supportMean - pairs[a].supportMean);
    out.push({
      label,
      badge: { cx: reading.badge.cx, cy: reading.badge.cy },
      routeMs,
      legs: [...teeLegs, ...basketLegs],
      pairs,
      rankOrder,
    });
  }
  return out;
}

/**
 * Drop-in browser-facing replacement for measureCoursePairs. Offline replay
 * scripts can keep importing the frozen base measurement until this closure
 * pass has its own corpus numbers.
 */
export function measureCoursePairs(inputs: CoursePairingInputs): CoursePairingLedgerResult {
  // Keep the measured badge patch from the frozen stack. The signed patch
  // below is additive: it specifically recovers cases the positive-only
  // one-sided rule cannot represent.
  const base = measureBaseCoursePairs(inputs);
  const spriteScale = inputs.native ? (inputs.geoScale ?? 1) : 1;
  const boxes: OccluderBox[] = [
    ...base.badges.map((b) => ({
      kind: 'badge' as const,
      xPx: b.cx,
      yPx: b.cy,
      widthPx: b.bboxW,
      heightPx: b.bboxH,
    })),
    ...base.basketPoints.map((b) => ({
      kind: 'basket' as const,
      xPx: b.cx,
      yPx: b.cy,
      widthPx: 42 * spriteScale,
      heightPx: 66 * spriteScale,
    })),
  ];

  const model = learnLiftModel(inputs.image, base, inputs.corridorWidthPx, boxes);
  let signedOccluderPatchedCells = 0;
  let contrastGapPatchedCells = 0;
  if (model) {
    signedOccluderPatchedCells = patchSignedKnownOccluders(base.field, inputs.image, model, boxes, inputs.corridorWidthPx);
    contrastGapPatchedCells = patchShortContrastGaps(base.field, inputs.image, model, inputs.corridorWidthPx, boxes);
  }

  const runtimeRecoveries = recoverRuntimeOccludedTees(inputs.image, base, boxes, inputs.corridorWidthPx);
  const teePoints = [...base.teePoints, ...runtimeRecoveries];

  // Freeze routing support BEFORE walking-path / narrow-linear discount.
  // The discount is evidence attribution, not a new steering force.
  const routeSupport = new Float32Array(base.field.support);
  const rerouted = signedOccluderPatchedCells > 0 || contrastGapPatchedCells > 0 || runtimeRecoveries.length > 0;

  let consistencyDiscountedCells = 0;
  if (model) {
    consistencyDiscountedCells = discountNonCorridorLinearSupport(
      base.field,
      inputs.image,
      model,
      inputs.corridorWidthPx,
      boxes,
      base.basketPoints,
    );
  }

  const matrices = rebuildMatrices(
    inputs.courseName,
    base,
    teePoints,
    base.basketPoints,
    routeSupport,
    rerouted,
  );

  const stats: RenderLedgerStats = {
    straightCalibrationTriples: model?.straightTriples ?? 0,
    calibrationSamples: model?.sampleCount ?? 0,
    bucketCounts: model?.buckets.map((b) => b.count) ?? [0, 0, 0, 0],
    bucketMeanLift: model?.buckets.map((b) => b.mean) ?? [0, 0, 0, 0],
    signedOccluderPatchedCells,
    contrastGapPatchedCells,
    consistencyDiscountedCells,
    runtimeRecoveredTees: runtimeRecoveries.length,
    rerouted,
  };
  inputs.onLog?.(
    `${inputs.courseName}: render-ledger straight=${stats.straightCalibrationTriples} samples=${stats.calibrationSamples} ` +
      `buckets=${stats.bucketCounts.join('/')} lift=${stats.bucketMeanLift.map((v) => v.toFixed(1)).join('/')} ` +
      `occluder+${signedOccluderPatchedCells} gap+${contrastGapPatchedCells} ` +
      `linearDiscount=${consistencyDiscountedCells} recoveredTees=${runtimeRecoveries.length} reroute=${rerouted}`,
  );

  return {
    ...base,
    teePoints,
    matrices,
    ledgerStats: stats,
  };
}
