/**
 * NuThing P2 course pair-evidence measurement — the pair-matrix measurement
 * core (badge/sprite/tee staging, ribbon support field, per-badge Dijkstra,
 * canonical tee→badge→basket pair evidence), extracted verbatim from
 * scripts/nuthing/pair-matrix.ts so the Node script and the in-browser
 * Course Vision producer run the SAME code. The script keeps IO, truth
 * matching, overlays, and cache emission; this module owns everything that
 * turns a raster into scored pair evidence.
 *
 * Dual-scale captures (CX-058): basket sprites and number badges are
 * screen-space furniture (fixed 42x66 sprite, fixed badge frame), while
 * corridors, zones and tee pads are geographic. A capture at a different
 * map zoom supplies `native` (screen-space raster) alongside `image` (the
 * geometry raster = native downscaled by `geoScale`); badges/sprites are
 * detected on the native raster and mapped into the geometry frame, where
 * every dev-tuned geometric constant applies unchanged.
 */
import { runBadgeStage } from './badgeStage';
import type { BadgeStageResult } from './badgeStage';
import { readCourseBadges } from './digits/readBadges';
import type { BadgeReading, DigitScorer } from './digits/readBadges';
import { computeRibbonSupport } from './ribbon';
import type { SupportField } from './ribbon';
import {
  matchBasketSprites,
  detectTeeRings,
  collectTeePoints
} from './endpoints';
import { patchBadgeOcclusion } from './badgeOcclusion';
import { buildSupportCost } from '../autoAnnotation/middleOutRibbon';
import type { RgbaImage } from './raster';

// Known-good field/route parameters (middleout.py lineage; see pair-matrix.ts).
export const FIELD_SCALE = 3;
export const FIELD_ORIENTATIONS = 12;
export const FIELD_WIDTHS_SRC = [24, 32, 40, 48, 56, 64];
export const WAIVER_RADIUS_FIELD = 6;
export const WAIVER_MAX_COST = 1.4;
export const SUPPORT_TAU = 0.5;
export const WORST_WINDOW_SRC_PX = 45;

// ---------------------------------------------------------------------------
// Full-field single-source Dijkstra (8-connected, edge weight
// 0.5*(c_u+c_v)*step, geometric steps) with prev backtracking. Dial/bucket
// queue: edge weights are bounded by 0.5*(5+5)*sqrt2 ≈ 7.08.
// ---------------------------------------------------------------------------
const DX = [-1, 0, 1, -1, 1, -1, 0, 1];
const DY = [-1, -1, -1, 0, 0, 1, 1, 1];
const STEP = [Math.SQRT2, 1, Math.SQRT2, 1, 1, Math.SQRT2, 1, Math.SQRT2];
const QUANTUM = 0.125;
const RING = 64; // > maxEdge/QUANTUM + 1

export function dijkstraFrom(
  cost: Float32Array,
  w: number,
  h: number,
  seedX: number,
  seedY: number
): { dist: Float64Array; prev: Int32Array } {
  const n = w * h;
  // Waiver disk at the source (badge glyph must not block its own legs).
  const local = new Float32Array(cost);
  const r = WAIVER_RADIUS_FIELD;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      const x = seedX + dx;
      const y = seedY + dy;
      if (x < 0 || x >= w || y < 0 || y >= h) continue;
      const i = y * w + x;
      if (local[i] > WAIVER_MAX_COST) local[i] = WAIVER_MAX_COST;
    }
  }
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const buckets: number[][] = Array.from({ length: RING }, () => []);
  const seed = seedY * w + seedX;
  dist[seed] = 0;
  buckets[0].push(seed);
  let pending = 1;
  let cursor = 0;
  while (pending > 0) {
    const bucket = buckets[cursor % RING];
    if (bucket.length === 0) {
      cursor++;
      continue;
    }
    const idx = bucket.pop() as number;
    pending--;
    if (done[idx]) continue;
    // Stale entry (a cheaper copy was queued later in an earlier bucket).
    if (Math.floor(dist[idx] / QUANTUM) > cursor) {
      buckets[Math.floor(dist[idx] / QUANTUM) % RING].push(idx);
      pending++;
      continue;
    }
    done[idx] = 1;
    const x = idx % w;
    const y = (idx - x) / w;
    const d = dist[idx];
    for (let k = 0; k < 8; k++) {
      const nx = x + DX[k];
      const ny = y + DY[k];
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const ni = ny * w + nx;
      if (done[ni]) continue;
      const cand = d + 0.5 * (local[idx] + local[ni]) * STEP[k];
      if (cand < dist[ni]) {
        dist[ni] = cand;
        prev[ni] = idx;
        buckets[Math.floor(cand / QUANTUM) % RING].push(ni);
        pending++;
      }
    }
  }
  return { dist, prev };
}

/** Backtracked field-cell path from a goal cell to the Dijkstra seed (seed-first order). */
export function backtrack(prev: Int32Array, goal: number): Int32Array {
  const cells: number[] = [];
  for (let c = goal; c >= 0; c = prev[c]) cells.push(c);
  cells.reverse();
  return Int32Array.from(cells);
}

export interface LegEvidence {
  /** 'T<i>' or 'B<i>' */
  endpointId: string;
  /** Accumulated Dijkstra cost badge→endpoint (goal-side waiver not applied). */
  geodesic: number;
  /** Field-cell path badge→endpoint, as [x0,y0,x1,y1,...] field coords. */
  path: number[];
  reachable: boolean;
}

export interface PairEvidence {
  pairId: string;
  teeId: string;
  basketId: string;
  totalScore: number;
  supportMean: number;
  supportMin: number;
  supportedFraction: number;
  /** Minimum over ~45src-px sliding windows of mean support. Primary ranking signal. */
  worstWindowMean: number;
  weakSpanCount: number;
  weakSpanLongestPx: number;
  pathLengthPx: number;
  straightDistancePx: number;
  efficiency: number;
  endpointSupportTee: number;
  endpointSupportBasket: number;
  failureReason: string | null;
}

export interface BadgeMatrix {
  label: string;
  badge: { cx: number; cy: number };
  routeMs: number;
  legs: LegEvidence[];
  pairs: PairEvidence[];
  /** Pair indices sorted by primary score (worstWindowMean desc, supportMean tie-break). */
  rankOrder: number[];
}

export interface CourseTeePoint {
  x: number;
  y: number;
  tier: string;
  angle: number | null;
  onRing: boolean;
}

export interface CourseBasketPoint {
  x: number;
  y: number;
  cx: number;
  cy: number;
  score: number;
}

export interface CoursePairingInputs {
  /** Course name — used only for pair ids and logs. */
  courseName: string;
  /** Geometry raster, already viewport-cropped. */
  image: RgbaImage;
  /** Geometry raster's crop offset in the full capture (viewport.top). */
  viewportTop: number;
  /**
   * Screen-space raster (already viewport-cropped) when the capture zoom
   * differs from the dev render zoom; omit to stage badges/sprites on
   * `image` itself.
   */
  native?: { image: RgbaImage; viewportTop: number };
  /** Geometry px per native px (0.5 = capture at 2x dev zoom). Default 1. */
  geoScale?: number;
  corridorWidthPx: number;
  /** Occlusion-aware badge patching (halo cap + one-sided edge evidence). */
  patchBadges: boolean;
  spriteTemplate: ReturnType<typeof import('./endpoints').prepareSpriteTemplate>;
  digitScorer: DigitScorer;
  /** Occluded-tee recoveries in FULL-raster geometry-frame coordinates. */
  recoveredTees?: readonly { xPx: number; yPx: number }[];
  onLog?: (message: string) => void;
}

export interface CoursePairingResult {
  field: SupportField;
  /** Badge components in the geometry frame (bbox/coords mapped). */
  badges: BadgeStageResult['badges'];
  /** Digit readings with `.badge` mapped into the geometry frame. */
  readings: BadgeReading[];
  teePoints: CourseTeePoint[];
  basketPoints: CourseBasketPoint[];
  matrices: BadgeMatrix[];
  patchStats: { haloCells: number; patchedCells: number } | null;
}

export function measureCoursePairs(inputs: CoursePairingInputs): CoursePairingResult {
  const {
    courseName: nm,
    image,
    viewportTop,
    native,
    geoScale = 1,
    corridorWidthPx,
    patchBadges,
    spriteTemplate,
    digitScorer,
    recoveredTees,
    onLog
  } = inputs;

  const stage = runBadgeStage(image);
  // Screen-space stage: badges + sprites detect on the native raster when
  // one is supplied (dual-scale capture), else on the geometry raster.
  let badgeStage = stage;
  let mapX = (x: number): number => x;
  let mapY = (y: number): number => y;
  let sizeScale = 1;
  if (native) {
    badgeStage = runBadgeStage(native.image);
    sizeScale = geoScale;
    mapX = (x) => x * geoScale;
    mapY = (y) => (y + native.viewportTop) * geoScale - viewportTop;
  }
  const scaleComp = <T extends { cx: number; cy: number; bboxX: number; bboxY: number; bboxW: number; bboxH: number; area: number }>(c: T): T => ({
    ...c,
    cx: mapX(c.cx),
    cy: mapY(c.cy),
    bboxX: mapX(c.bboxX),
    bboxY: mapY(c.bboxY),
    bboxW: c.bboxW * sizeScale,
    bboxH: c.bboxH * sizeScale,
    area: c.area * sizeScale * sizeScale
  });
  const badges = badgeStage.badges.map(scaleComp);
  const readings = readCourseBadges(badgeStage, digitScorer).map((r) => ({
    ...r,
    badge: scaleComp(r.badge)
  }));
  const field: SupportField = computeRibbonSupport(image, {
    scale: FIELD_SCALE,
    orientations: FIELD_ORIENTATIONS,
    widthsSrc: FIELD_WIDTHS_SRC
  });
  let patchStats: { haloCells: number; patchedCells: number } | null = null;
  if (patchBadges) {
    const stats = patchBadgeOcclusion(field, image, badges, corridorWidthPx);
    patchStats = { haloCells: stats.haloCells, patchedCells: stats.patchedCells };
    onLog?.(
      `${nm}: badge-occlusion patch W=${corridorWidthPx}: halo-capped ${stats.haloCells} cells, ` +
        `one-sided boosted ${stats.patchedCells} cells`
    );
  }
  const cost = buildSupportCost(field.support);

  // --- Endpoints: render-identity detectors (endpoints.ts) ------------------
  const insideBadgePt = (x: number, y: number): boolean =>
    badges.some(
      (b) =>
        x >= b.bboxX - 3 && x <= b.bboxX + b.bboxW + 3 &&
        y >= b.bboxY - 3 && y <= b.bboxY + b.bboxH + 3
    );
  // Ring-tier tees are excluded only from the badge PLATE INTERIOR (where
  // hollow digit glyphs like 0/8 can pose as tee rings) — a real tee can
  // stand at the badge frame's edge (measured: Heritage h15).
  const insideBadgeInterior = (x: number, y: number): boolean =>
    badges.some(
      (b) => Math.abs(x - b.cx) <= b.bboxW / 2 - 7 && Math.abs(y - b.cy) <= b.bboxH / 2 - 7
    );
  const sprites = matchBasketSprites(badgeStage.brightMask, spriteTemplate).map((s) => ({
    ...s,
    cx: mapX(s.cx),
    cy: mapY(s.cy),
    tipX: mapX(s.tipX),
    tipY: mapY(s.tipY)
  }));
  const rings = detectTeeRings(stage.brightMask).filter((r) => !insideBadgeInterior(r.cx, r.cy));
  const badgeLabels = new Set(stage.badges.map((b) => b.label));
  const teeComponents = stage.brightComponents.filter(
    (c) => !badgeLabels.has(c.label) && !insideBadgePt(c.cx, c.cy)
  );
  const teeCands = collectTeePoints(rings, teeComponents, sprites);
  // Basket endpoint: pole tip (matched-filter sprite position + fixed offset).
  const basketPoints: CourseBasketPoint[] = sprites.map((s) => ({
    x: s.tipX,
    y: s.tipY,
    cx: s.cx,
    cy: s.cy,
    score: s.score
  }));
  // onRing: tee standing on some basket's C2D dashed circle (radius ~84).
  // angle: ring-tier tees carry the hole's principal-axis orientation
  // (validated on dev truth: points at the hole's badge, median error 1.1°).
  const teePoints: CourseTeePoint[] = teeCands.map((t) => ({
    x: t.cx,
    y: t.cy,
    tier: t.tier,
    angle: t.ring ? t.ring.angle : null,
    onRing: basketPoints.some((b) => Math.abs(Math.hypot(t.cx - b.x, t.cy - b.y) - 84) <= 12)
  }));
  // Occluded-tee recoveries: pads hidden under basket sprites / badges that
  // the render-identity detectors cannot see (tier 'recovered', dedupe 14px).
  for (const r of recoveredTees ?? []) {
    const rx = r.xPx;
    const ry = r.yPx - viewportTop;
    if (teePoints.some((t) => Math.hypot(t.x - rx, t.y - ry) < 14)) continue;
    teePoints.push({
      x: rx,
      y: ry,
      tier: 'recovered',
      angle: null,
      onRing: basketPoints.some((b) => Math.abs(Math.hypot(rx - b.x, ry - b.y) - 84) <= 12)
    });
  }

  // --- Per-badge matrix ------------------------------------------------------
  const clampCell = (v: number, hi: number): number => Math.max(0, Math.min(hi - 1, Math.round(v)));
  const toCell = (x: number, y: number): number =>
    clampCell(y / field.scale, field.height) * field.width + clampCell(x / field.scale, field.width);
  const supportAt = (cell: number): number => field.support[cell];

  const matrices: BadgeMatrix[] = [];
  const windowCells = Math.max(3, Math.round(WORST_WINDOW_SRC_PX / field.scale));
  const nowMs = (): number =>
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();

  for (const r of readings) {
    if (!r.label) continue;
    const tR = nowMs();
    const bx = clampCell(r.badge.cx / field.scale, field.width);
    const by = clampCell(r.badge.cy / field.scale, field.height);
    const { dist, prev } = dijkstraFrom(cost, field.width, field.height, bx, by);

    const legFor = (id: string, x: number, y: number): LegEvidence => {
      const goal = toCell(x, y);
      const reachable = Number.isFinite(dist[goal]);
      const cells = reachable ? backtrack(prev, goal) : new Int32Array(0);
      const path: number[] = [];
      for (const c of cells) path.push(c % field.width, (c - (c % field.width)) / field.width);
      return { endpointId: id, geodesic: reachable ? dist[goal] : Infinity, path, reachable };
    };
    const teeLegs = teePoints.map((p, i) => legFor(`T${i}`, p.x, p.y));
    const basketLegs = basketPoints.map((p, i) => legFor(`B${i}`, p.x, p.y));

    const pairs: PairEvidence[] = [];
    for (let ti = 0; ti < teeLegs.length; ti++) {
      for (let bi = 0; bi < basketLegs.length; bi++) {
        const tl = teeLegs[ti];
        const bl = basketLegs[bi];
        const pairId = `${nm}:h${r.label}:T${ti}:B${bi}`;
        if (!tl.reachable || !bl.reachable) {
          pairs.push({
            pairId, teeId: `T${ti}`, basketId: `B${bi}`,
            totalScore: Infinity, supportMean: 0, supportMin: 0, supportedFraction: 0,
            worstWindowMean: 0, weakSpanCount: 0, weakSpanLongestPx: 0,
            pathLengthPx: 0, straightDistancePx: 0, efficiency: 0,
            endpointSupportTee: 0, endpointSupportBasket: 0,
            failureReason: 'unreachable'
          });
          continue;
        }
        // Canonical form: tee→badge→basket = reverse(badge→tee) + badge→basket[1:]
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
            const j = (nT - 1 - s) * 2; // tee-first
            x = tl.path[j];
            y = tl.path[j + 1];
          } else {
            const j = (s - nT + 1) * 2; // skip duplicated badge cell
            x = bl.path[j];
            y = bl.path[j + 1];
          }
          samples[s] = supportAt(y * field.width + x);
          if (px >= 0) lengthCells += Math.hypot(x - px, y - py);
          px = x;
          py = y;
        }
        let sum = 0;
        let min = 1;
        let supported = 0;
        for (let s = 0; s < count; s++) {
          sum += samples[s];
          if (samples[s] < min) min = samples[s];
          if (samples[s] >= SUPPORT_TAU) supported++;
        }
        // Weak spans: maximal runs below tau.
        let weakSpanCount = 0;
        let weakSpanLongest = 0;
        let run = 0;
        for (let s = 0; s <= count; s++) {
          if (s < count && samples[s] < SUPPORT_TAU) run++;
          else {
            if (run > 0) {
              weakSpanCount++;
              if (run > weakSpanLongest) weakSpanLongest = run;
            }
            run = 0;
          }
        }
        // Weakest sliding window (mean support).
        let worst = 1;
        if (count <= windowCells) {
          worst = sum / count;
        } else {
          let acc = 0;
          for (let s = 0; s < windowCells; s++) acc += samples[s];
          worst = acc / windowCells;
          for (let s = windowCells; s < count; s++) {
            acc += samples[s] - samples[s - windowCells];
            const m = acc / windowCells;
            if (m < worst) worst = m;
          }
        }
        const straight =
          Math.hypot(teePoints[ti].x - r.badge.cx, teePoints[ti].y - r.badge.cy) +
          Math.hypot(basketPoints[bi].x - r.badge.cx, basketPoints[bi].y - r.badge.cy);
        const endMean = (leg: LegEvidence): number => {
          const m = leg.path.length / 2;
          const k = Math.min(3, m);
          let a = 0;
          for (let s = 0; s < k; s++) {
            const j = (m - 1 - s) * 2;
            a += supportAt(leg.path[j + 1] * field.width + leg.path[j]);
          }
          return k ? a / k : 0;
        };
        pairs.push({
          pairId, teeId: `T${ti}`, basketId: `B${bi}`,
          totalScore: tl.geodesic + bl.geodesic,
          supportMean: sum / count,
          supportMin: min,
          supportedFraction: supported / count,
          worstWindowMean: worst,
          weakSpanCount,
          weakSpanLongestPx: Math.round(weakSpanLongest * field.scale),
          pathLengthPx: lengthCells * field.scale,
          straightDistancePx: straight,
          efficiency: straight > 0 ? (lengthCells * field.scale) / straight : 0,
          endpointSupportTee: endMean(tl),
          endpointSupportBasket: endMean(bl),
          failureReason: null
        });
      }
    }
    const rankOrder = pairs
      .map((_, i) => i)
      .sort(
        (a, b) =>
          pairs[b].worstWindowMean - pairs[a].worstWindowMean ||
          pairs[b].supportMean - pairs[a].supportMean
      );
    matrices.push({
      label: r.label,
      badge: { cx: r.badge.cx, cy: r.badge.cy },
      routeMs: nowMs() - tR,
      legs: [...teeLegs, ...basketLegs],
      pairs,
      rankOrder
    });
  }

  return { field, badges, readings, teePoints, basketPoints, matrices, patchStats };
}
