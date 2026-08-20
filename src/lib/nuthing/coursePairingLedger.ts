/**
 * NuThing render-ledger closure pass.
 *
 * Keep the frozen paired-edge field authoritative. This wrapper only adds
 * evidence where that field is demonstrably MISSING evidence: a short low-
 * support gap bracketed by healthy support, or one ribbon flank hidden by a
 * known badge/basket occluder. It deliberately does not globally discount
 * "non-corridor-looking" support; the first browser replay proved that a
 * course-wide paint-consistency discount changes tens of thousands of real
 * support cells and can destroy otherwise-correct Dashs assignments.
 */

import {
  backtrack,
  dijkstraFrom,
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
import type { TeeOcclusionBadgeBox } from '../autoAnnotation/teeOcclusionRecovery';
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
const STRAIGHT_BASE_WORST_MIN = 0.28;
const STRAIGHT_BASE_SUPPORTED_MIN = 0.55;

// These are intentionally the same crude gates that survived the Rec
// prototype. A new signal may only fill a HOLE in the paired-edge field.
const LOW_SUPPORT = 0.18;
const HEALTHY_SUPPORT = 0.28;
const MAX_LOOK_FIELD = 3;
const EDGE_SCORE_MIN = 0.65;
const SUPPORT_CAP = 0.55;

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
  /** Reserved for explicit walking-path attribution. Global discount is off. */
  readonly consistencyDiscountedCells: number;
  /** Runtime recovery is deliberately disabled until its real-data gate passes. */
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

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
}

function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
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
  const local = model.buckets[bucketIndex(outside)];
  const stats = local.count >= MIN_BUCKET_COUNT ? local : model.global;
  const observed = inside - outside;
  const sigma = Math.max(8, stats.mad * 1.4826, Math.abs(stats.mean) * 0.35);
  const z = Math.abs(observed - stats.mean) / sigma;
  return Math.exp(-0.5 * z * z);
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
  const cosine = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (an * bn)));
  return Math.acos(cosine);
}

function basePairFor(
  result: CoursePairingResult,
  label: string,
  teeIndex: number,
  basketIndex: number,
): PairEvidence | null {
  const matrix = result.matrices.find((m) => m.label === label);
  return matrix?.pairs.find((p) => p.teeId === `T${teeIndex}` && p.basketId === `B${basketIndex}`) ?? null;
}

/**
 * Learn the signed effect of UDisc corridor paint from only triples that are
 * independently self-consistent in geometry AND already healthy in the
 * frozen paired-edge field. No truth/course identity is used.
 */
function learnLiftModel(
  image: RgbaImage,
  result: CoursePairingResult,
  corridorWidthPx: number,
  occluders: readonly OccluderBox[],
): RibbonLiftModel | null {
  const samples: number[][] = Array.from({ length: BUCKET_COUNT }, () => []);
  const usedTees = new Set<number>();
  const usedBaskets = new Set<number>();
  let straightTriples = 0;
  const maxAxis = (STRAIGHT_AXIS_MAX_DEG * Math.PI) / 180;
  const maxRay = (STRAIGHT_RAY_MAX_DEG * Math.PI) / 180;

  for (const reading of result.readings) {
    if (!reading.label) continue;
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
        const vv = vx * vx + vy * vy;
        if (vv < 1) continue;
        const frac = (dbx * vx + dby * vy) / vv;
        if (frac < STRAIGHT_FRAC_MIN || frac > STRAIGHT_FRAC_MAX) continue;
        const ray = directedAngleRad(dbx, dby, vx, vy);
        if (ray > maxRay) continue;
        const perp = Math.abs(dbx * vy - dby * vx) / Math.sqrt(vv);
        if (perp > Math.max(5, corridorWidthPx * 0.16)) continue;
        const pair = basePairFor(result, reading.label, ti, bi);
        if (
          !pair ||
          pair.worstWindowMean < STRAIGHT_BASE_WORST_MIN ||
          pair.supportedFraction < STRAIGHT_BASE_SUPPORTED_MIN
        ) continue;
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
    if (usedTees.has(best.ti) || usedBaskets.has(best.bi)) continue;
    usedTees.add(best.ti);
    usedBaskets.add(best.bi);
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

    for (
      let along = Math.max(20, corridorWidthPx);
      along <= length - Math.max(95, corridorWidthPx * 2.4);
      along += step
    ) {
      const cx = tee.x + ux * along;
      const cy = tee.y + uy * along;
      if (insideAnyBox(occluders, cx, cy, 22)) continue;
      for (const sign of [-1, 1] as const) {
        const inside = luma(
          image,
          cx + sign * nx * (half - EDGE_DELTA_PX),
          cy + sign * ny * (half - EDGE_DELTA_PX),
        );
        const outside = luma(
          image,
          cx + sign * nx * (half + EDGE_DELTA_PX),
          cy + sign * ny * (half + EDGE_DELTA_PX),
        );
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
  for (let step = 1; step <= MAX_LOOK_FIELD; step++) {
    const x = Math.round(fx + sign * ux * step);
    const y = Math.round(fy + sign * uy * step);
    if (x < 0 || y < 0 || x >= field.width || y >= field.height) continue;
    if (support[y * field.width + x] >= HEALTHY_SUPPORT) return true;
  }
  return false;
}

/** Find one nearby healthy cell and borrow only its already-measured theta. */
function anchorTheta(
  support: Float32Array,
  field: SupportField,
  fx: number,
  fy: number,
): number | null {
  let best = -1;
  let bestSupport = 0;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      if (dx === 0 && dy === 0) continue;
      const x = fx + dx;
      const y = fy + dy;
      if (x < 0 || y < 0 || x >= field.width || y >= field.height) continue;
      const i = y * field.width + x;
      if (support[i] > bestSupport) {
        bestSupport = support[i];
        best = i;
      }
    }
  }
  return best >= 0 && bestSupport >= HEALTHY_SUPPORT ? field.bestTheta[best] : null;
}

function visibleEdgeScore(
  image: RgbaImage,
  model: RibbonLiftModel,
  boxes: readonly OccluderBox[],
  x: number,
  y: number,
  theta: number,
  corridorWidthPx: number,
): number | null {
  const nx = -Math.sin(theta);
  const ny = Math.cos(theta);
  const half = corridorWidthPx / 2;
  const samples = [
    [x - nx * (half - EDGE_DELTA_PX), y - ny * (half - EDGE_DELTA_PX)],
    [x - nx * (half + EDGE_DELTA_PX), y - ny * (half + EDGE_DELTA_PX)],
    [x + nx * (half - EDGE_DELTA_PX), y + ny * (half - EDGE_DELTA_PX)],
    [x + nx * (half + EDGE_DELTA_PX), y + ny * (half + EDGE_DELTA_PX)],
  ] as const;
  const leftBlocked = insideAnyBox(boxes, samples[0][0], samples[0][1], 2) ||
    insideAnyBox(boxes, samples[1][0], samples[1][1], 2);
  const rightBlocked = insideAnyBox(boxes, samples[2][0], samples[2][1], 2) ||
    insideAnyBox(boxes, samples[3][0], samples[3][1], 2);
  if (leftBlocked === rightBlocked) return null;
  const insidePoint = leftBlocked ? samples[2] : samples[0];
  const outsidePoint = leftBlocked ? samples[3] : samples[1];
  const inside = luma(image, insidePoint[0], insidePoint[1]);
  const outside = luma(image, outsidePoint[0], outsidePoint[1]);
  if (inside === null || outside === null) return null;
  return edgeAgreement(model, outside, inside);
}

/**
 * One-edge repair around known opaque furniture. It is intentionally narrow:
 * the center cell must itself be weak, sit OUTSIDE the opaque box, borrow a
 * direction from nearby healthy paired evidence, and have healthy support on
 * both sides along that direction. No orientation shopping is allowed.
 */
function patchKnownOccluderGaps(
  field: SupportField,
  image: RgbaImage,
  model: RibbonLiftModel,
  boxes: readonly OccluderBox[],
  corridorWidthPx: number,
): number {
  const before = new Float32Array(field.support);
  const reach = corridorWidthPx / 2 + 7;
  let patched = 0;

  for (const box of boxes) {
    const fx0 = Math.max(1, Math.floor((box.xPx - box.widthPx / 2 - reach) / field.scale));
    const fx1 = Math.min(field.width - 2, Math.ceil((box.xPx + box.widthPx / 2 + reach) / field.scale));
    const fy0 = Math.max(1, Math.floor((box.yPx - box.heightPx / 2 - reach) / field.scale));
    const fy1 = Math.min(field.height - 2, Math.ceil((box.yPx + box.heightPx / 2 + reach) / field.scale));
    for (let fy = fy0; fy <= fy1; fy++) {
      for (let fx = fx0; fx <= fx1; fx++) {
        const i = fy * field.width + fx;
        if (before[i] >= LOW_SUPPORT) continue;
        const x = fx * field.scale + field.scale / 2;
        const y = fy * field.scale + field.scale / 2;
        if (insideAnyBox(boxes, x, y, 1)) continue;
        const theta = anchorTheta(before, field, fx, fy);
        if (theta === null) continue;
        if (!healthyAlong(before, field, fx, fy, theta, -1) || !healthyAlong(before, field, fx, fy, theta, 1)) continue;
        const score = visibleEdgeScore(image, model, boxes, x, y, theta, corridorWidthPx);
        if (score === null || score < EDGE_SCORE_MIN) continue;
        const proposal = Math.min(SUPPORT_CAP, 0.30 + 0.30 * score);
        if (proposal <= field.support[i]) continue;
        field.support[i] = proposal;
        field.bestTheta[i] = theta;
        patched++;
      }
    }
  }
  return patched;
}

function twoEdgeScores(
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

/** The exact crude Rec prototype: bridge only a short, bracketed weak gap. */
function patchShortContrastGaps(
  field: SupportField,
  image: RgbaImage,
  model: RibbonLiftModel,
  boxes: readonly OccluderBox[],
  corridorWidthPx: number,
): number {
  const before = new Float32Array(field.support);
  let patched = 0;
  for (let fy = 2; fy < field.height - 2; fy++) {
    for (let fx = 2; fx < field.width - 2; fx++) {
      const i = fy * field.width + fx;
      if (before[i] >= LOW_SUPPORT) continue;
      const x = fx * field.scale + field.scale / 2;
      const y = fy * field.scale + field.scale / 2;
      if (insideAnyBox(boxes, x, y, 3)) continue;
      const theta = anchorTheta(before, field, fx, fy);
      if (theta === null) continue;
      if (!healthyAlong(before, field, fx, fy, theta, -1) || !healthyAlong(before, field, fx, fy, theta, 1)) continue;
      const scores = twoEdgeScores(image, model, x, y, theta, corridorWidthPx);
      if (!scores) continue;
      const score = Math.max(scores[0], scores[1]); // one good flank is enough
      if (score < EDGE_SCORE_MIN) continue;
      const proposal = Math.min(SUPPORT_CAP, 0.30 + 0.30 * score);
      if (proposal <= field.support[i]) continue;
      field.support[i] = proposal;
      field.bestTheta[i] = theta;
      patched++;
    }
  }
  return patched;
}

function clampCell(value: number, hi: number): number {
  return Math.max(0, Math.min(hi - 1, Math.round(value)));
}

function legFor(
  endpointId: string,
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
  for (const cell of cells) path.push(cell % field.width, Math.floor(cell / field.width));
  return { endpointId, geodesic: reachable ? dist[goal] : Infinity, path, reachable };
}

function endMean(leg: LegEvidence, field: SupportField): number {
  const count = leg.path.length / 2;
  const k = Math.min(3, count);
  if (!k) return 0;
  let sum = 0;
  for (let s = 0; s < k; s++) {
    const j = (count - 1 - s) * 2;
    sum += field.support[leg.path[j + 1] * field.width + leg.path[j]];
  }
  return sum / k;
}

function buildPair(
  courseName: string,
  label: string,
  badgeX: number,
  badgeY: number,
  ti: number,
  bi: number,
  teeLeg: LegEvidence,
  basketLeg: LegEvidence,
  tees: readonly CourseTeePoint[],
  baskets: readonly CourseBasketPoint[],
  field: SupportField,
): PairEvidence {
  const pairId = `${courseName}:h${label}:T${ti}:B${bi}`;
  if (!teeLeg.reachable || !basketLeg.reachable) {
    return {
      pairId,
      teeId: `T${ti}`,
      basketId: `B${bi}`,
      totalScore: Infinity,
      supportMean: 0,
      supportMin: 0,
      supportedFraction: 0,
      worstWindowMean: 0,
      weakSpanCount: 0,
      weakSpanLongestPx: 0,
      pathLengthPx: 0,
      straightDistancePx: 0,
      efficiency: 0,
      endpointSupportTee: 0,
      endpointSupportBasket: 0,
      failureReason: 'unreachable',
    };
  }

  const nT = teeLeg.path.length / 2;
  const nB = basketLeg.path.length / 2;
  const count = nT + nB - 1;
  const samples = new Float32Array(count);
  let lengthCells = 0;
  let previousX = -1;
  let previousY = -1;
  for (let s = 0; s < count; s++) {
    let x: number;
    let y: number;
    if (s < nT) {
      const j = (nT - 1 - s) * 2;
      x = teeLeg.path[j];
      y = teeLeg.path[j + 1];
    } else {
      const j = (s - nT + 1) * 2;
      x = basketLeg.path[j];
      y = basketLeg.path[j + 1];
    }
    samples[s] = field.support[y * field.width + x];
    if (previousX >= 0) lengthCells += Math.hypot(x - previousX, y - previousY);
    previousX = x;
    previousY = y;
  }

  let sum = 0;
  let minSupport = 1;
  let supported = 0;
  for (const sample of samples) {
    sum += sample;
    minSupport = Math.min(minSupport, sample);
    if (sample >= SUPPORT_TAU) supported++;
  }

  let weakSpanCount = 0;
  let weakSpanLongest = 0;
  let run = 0;
  for (let s = 0; s <= samples.length; s++) {
    if (s < samples.length && samples[s] < SUPPORT_TAU) {
      run++;
    } else if (run > 0) {
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
  const straightDistancePx =
    Math.hypot(tees[ti].x - badgeX, tees[ti].y - badgeY) +
    Math.hypot(baskets[bi].x - badgeX, baskets[bi].y - badgeY);

  return {
    pairId,
    teeId: `T${ti}`,
    basketId: `B${bi}`,
    totalScore: teeLeg.geodesic + basketLeg.geodesic,
    supportMean: sum / Math.max(samples.length, 1),
    supportMin: minSupport,
    supportedFraction: supported / Math.max(samples.length, 1),
    worstWindowMean,
    weakSpanCount,
    weakSpanLongestPx: Math.round(weakSpanLongest * field.scale),
    pathLengthPx,
    straightDistancePx,
    efficiency: straightDistancePx > 0 ? pathLengthPx / straightDistancePx : 0,
    endpointSupportTee: endMean(teeLeg, field),
    endpointSupportBasket: endMean(basketLeg, field),
    failureReason: null,
  };
}

function rerouteMatrices(
  inputs: CoursePairingInputs,
  result: CoursePairingResult,
): BadgeMatrix[] {
  const cost = buildSupportCost(result.field.support);
  const matrices: BadgeMatrix[] = [];
  const now = (): number =>
    typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();

  for (const reading of result.readings) {
    if (!reading.label) continue;
    const started = now();
    const bx = clampCell(reading.badge.cx / result.field.scale, result.field.width);
    const by = clampCell(reading.badge.cy / result.field.scale, result.field.height);
    const { dist, prev } = dijkstraFrom(cost, result.field.width, result.field.height, bx, by);
    const teeLegs = result.teePoints.map((tee, i) =>
      legFor(`T${i}`, tee.x, tee.y, dist, prev, result.field),
    );
    const basketLegs = result.basketPoints.map((basket, i) =>
      legFor(`B${i}`, basket.x, basket.y, dist, prev, result.field),
    );
    const pairs: PairEvidence[] = [];
    for (let ti = 0; ti < teeLegs.length; ti++) {
      for (let bi = 0; bi < basketLegs.length; bi++) {
        pairs.push(
          buildPair(
            inputs.courseName,
            reading.label,
            reading.badge.cx,
            reading.badge.cy,
            ti,
            bi,
            teeLegs[ti],
            basketLegs[bi],
            result.teePoints,
            result.basketPoints,
            result.field,
          ),
        );
      }
    }
    const rankOrder = pairs
      .map((_, i) => i)
      .sort(
        (a, b) =>
          pairs[b].worstWindowMean - pairs[a].worstWindowMean ||
          pairs[b].supportMean - pairs[a].supportMean,
      );
    matrices.push({
      label: reading.label,
      badge: { cx: reading.badge.cx, cy: reading.badge.cy },
      routeMs: now() - started,
      legs: [...teeLegs, ...basketLegs],
      pairs,
      rankOrder,
    });
  }
  return matrices;
}

/** Browser-facing drop-in replacement for the frozen measurement. */
export function measureCoursePairs(inputs: CoursePairingInputs): CoursePairingLedgerResult {
  const base = measureBaseCoursePairs(inputs);
  const spriteScale = inputs.native ? (inputs.geoScale ?? 1) : 1;
  const boxes: OccluderBox[] = [
    ...base.badges.map((badge) => ({
      kind: 'badge' as const,
      xPx: badge.cx,
      yPx: badge.cy,
      widthPx: badge.bboxW,
      heightPx: badge.bboxH,
    })),
    ...base.basketPoints.map((basket) => ({
      kind: 'basket' as const,
      xPx: basket.cx,
      yPx: basket.cy,
      widthPx: 42 * spriteScale,
      heightPx: 66 * spriteScale,
    })),
  ];

  const model = learnLiftModel(inputs.image, base, inputs.corridorWidthPx, boxes);
  let signedOccluderPatchedCells = 0;
  let contrastGapPatchedCells = 0;
  if (model) {
    signedOccluderPatchedCells = patchKnownOccluderGaps(
      base.field,
      inputs.image,
      model,
      boxes,
      inputs.corridorWidthPx,
    );
    contrastGapPatchedCells = patchShortContrastGaps(
      base.field,
      inputs.image,
      model,
      boxes,
      inputs.corridorWidthPx,
    );
  }

  const rerouted = signedOccluderPatchedCells > 0 || contrastGapPatchedCells > 0;
  const matrices = rerouted ? rerouteMatrices(inputs, base) : base.matrices;
  const stats: RenderLedgerStats = {
    straightCalibrationTriples: model?.straightTriples ?? 0,
    calibrationSamples: model?.sampleCount ?? 0,
    bucketCounts: model?.buckets.map((bucket) => bucket.count) ?? [0, 0, 0, 0],
    bucketMeanLift: model?.buckets.map((bucket) => bucket.mean) ?? [0, 0, 0, 0],
    signedOccluderPatchedCells,
    contrastGapPatchedCells,
    consistencyDiscountedCells: 0,
    runtimeRecoveredTees: 0,
    rerouted,
  };

  inputs.onLog?.(
    `${inputs.courseName}: render-ledger straight=${stats.straightCalibrationTriples} samples=${stats.calibrationSamples} ` +
      `buckets=${stats.bucketCounts.join('/')} lift=${stats.bucketMeanLift.map((v) => v.toFixed(1)).join('/')} ` +
      `occluder+${signedOccluderPatchedCells} gap+${contrastGapPatchedCells} ` +
      `linearDiscount=0 recoveredTees=0 reroute=${rerouted}`,
  );

  return {
    ...base,
    matrices,
    ledgerStats: stats,
  };
}
