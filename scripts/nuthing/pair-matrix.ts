// Baseline tee×basket evidence matrix (P1.5, post-correction architecture).
//
// MiddleOut is a KNOWN-ENDPOINT route evaluator, not an endpoint-ownership
// detector. This script therefore does no ownership inference at all: it
// enumerates every (tee, basket) candidate pair per badge, routes each pair
// through ONE shared support field in the canonical middle-out form
// tee→badge→basket = reverse(badge→tee) + badge→basket[1:], and preserves
// full PathEvidence per pair. Ownership questions are answered afterwards by
// ranking the evidence — never by geodesic-closest / nearest-endpoint /
// greedy-assignment heuristics.
//
// Faithful to the known-good implementation
// (experiment/vision-middleout-pathfinding @ 34538e6,
// scripts/cv-probes/middleout/middleout.py):
//   - field: paired-edge support, scale 3, 12 orientations, widths 24..64,
//     99.5-pct normalize, gamma 0.7 (pure-TS port in src/lib/nuthing/ribbon)
//   - cost: 1 + 4*(1-s)^2  (middleOutRibbon.buildSupportCost)
//   - route: 8-connected geometric Dijkstra; endpoint waiver disk r=6 field
//     px clamped to cost 1.4 at the badge (the Dijkstra source). Deviation,
//     documented: legs to all ~43 endpoints share one Dijkstra per badge, so
//     the goal-side waiver is not applied; this shifts only the cost-based
//     totalScore (by a bounded goal-local glyph term), not the support
//     samples along the path, which the pair ranking is built from.
//   - NO C2D / walking-path / sprite suppression: the point of the baseline
//     matrix is to measure those failure mechanisms cleanly first.
//
// Endpoint refinement (detection hygiene, not routing suppression):
//   baskets = fixed 42×66 sprite family; endpoint = pole tip
//   (cx, cy + bboxH/2 + 4 = BASKET_SPRITE_TIP_OFFSET_PX below the pole).
//   tees = tee-rect family (widened bounds: real tees render 11..35px per
//   axis, fill 0.28..0.74, and occlusion merges some into ~275-area blobs),
//   excluding only badge boxes and badge digit glyphs. C2D ring furniture is
//   NOT excluded — true tees routinely sit ON a neighboring basket's ring
//   (diagnosed: 16 of 23 truth-tee misses under the ring exclusion were real
//   tees flagged as dash furniture). Ring-attributed candidates are tagged
//   `onRing` instead, so failures they cause are attributable to C2D.
//
// Outputs (cache-for-replay + human artifacts):
//   OUT_DIR/<course>.json        endpoints, badges, legs (with paths),
//                                 pair evidence rows, truth matches, ranks
//   OUT_DIR/<course>-field.bin   f32 support field (replay boundary)
//   OUT_DIR/<course>-true-pairs.png     true-pair routes colored by rank
//   OUT_DIR/<course>-h<N>-fail.png      per-failure: true (green) vs
//                                        strongest false competitor (red)
//
// Usage: npx tsx scripts/nuthing/pair-matrix.ts OUT_DIR [--course NAME]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { PNG } from 'pngjs';
import { runBadgeStage } from '../../src/lib/nuthing/badgeStage';
import { readCourseBadges } from '../../src/lib/nuthing/digits/readBadges';
import { predictProbs } from '../../src/lib/nuthing/digits/logistic';
import type { LogisticModel } from '../../src/lib/nuthing/digits/logistic';
import { computeRibbonSupport, attributeBasketZones } from '../../src/lib/nuthing/ribbon';
import type { SupportField } from '../../src/lib/nuthing/ribbon';
import { buildSupportCost } from '../../src/lib/autoAnnotation/middleOutRibbon';
import { detectMapViewport, cropRows } from '../../src/lib/nuthing/viewport';
import { decodeRgbaBin } from './decode';

// Known-good field/route parameters (middleout.py).
const FIELD_SCALE = 3;
const FIELD_ORIENTATIONS = 12;
const FIELD_WIDTHS_SRC = [24, 32, 40, 48, 56, 64];
const WAIVER_RADIUS_FIELD = 6;
const WAIVER_MAX_COST = 1.4;
// Support threshold for "supported" samples / weak spans (support is [0,1]
// after the 99.5-pct + gamma normalization; ribbon interiors sit near 1).
const SUPPORT_TAU = 0.5;
// Weakest-window width in source px: a convincing ribbon has no ~45px
// stretch of unsupported ground anywhere along it.
const WORST_WINDOW_SRC_PX = 45;
const TRUTH_TOL = 10;

interface TruthHole {
  number: number;
  tee: [number, number];
  basket: [number, number];
}

function loadTruth(): Record<string, TruthHole[]> {
  const reg = JSON.parse(
    readFileSync('resources/nuthing-p2/registered-annotations.json', 'utf8'),
  ) as Record<string, { registeredHoles: { number: number; tee: number[]; basket: number[] }[] }>;
  const dashs = JSON.parse(
    readFileSync(
      '/workspace/chainspot-corpus/dev/DashsTrack/DashsTrack-full.annotation.json',
      'utf8',
    ),
  ) as { holes: { number: number; tee: { xPx: number; yPx: number }; basket: { xPx: number; yPx: number } }[] };
  const out: Record<string, TruthHole[]> = {
    'DashsTrack-full': dashs.holes.map((h) => ({
      number: h.number,
      tee: [h.tee.xPx, h.tee.yPx],
      basket: [h.basket.xPx, h.basket.yPx],
    })),
  };
  for (const nm of ['HeritagePark-full', 'Lenard-full', 'TowneLake-full']) {
    out[nm] = reg[nm].registeredHoles.map((h) => ({
      number: h.number,
      tee: [h.tee[0], h.tee[1]],
      basket: [h.basket[0], h.basket[1]],
    }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Full-field single-source Dijkstra (known-good edge semantics: 8-connected,
// edge weight 0.5*(c_u+c_v)*step, geometric steps) with prev backtracking.
// Dial/bucket queue: edge weights are bounded by 0.5*(5+5)*sqrt2 ≈ 7.08.
// ---------------------------------------------------------------------------
const DX = [-1, 0, 1, -1, 1, -1, 0, 1];
const DY = [-1, -1, -1, 0, 0, 1, 1, 1];
const STEP = [Math.SQRT2, 1, Math.SQRT2, 1, 1, Math.SQRT2, 1, Math.SQRT2];
const QUANTUM = 0.125;
const RING = 64; // > maxEdge/QUANTUM + 1

function dijkstraFrom(
  cost: Float32Array,
  w: number,
  h: number,
  seedX: number,
  seedY: number,
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
function backtrack(prev: Int32Array, goal: number): Int32Array {
  const cells: number[] = [];
  for (let c = goal; c >= 0; c = prev[c]) cells.push(c);
  cells.reverse();
  return Int32Array.from(cells);
}

interface LegEvidence {
  /** 'T<i>' or 'B<i>' */
  endpointId: string;
  /** Accumulated Dijkstra cost badge→endpoint (goal-side waiver not applied). */
  geodesic: number;
  /** Field-cell path badge→endpoint, as [x0,y0,x1,y1,...] field coords. */
  path: number[];
  reachable: boolean;
}

interface PairEvidence {
  pairId: string;
  teeId: string;
  basketId: string;
  totalScore: number;
  supportMean: number;
  supportMin: number;
  supportedFraction: number;
  /** Minimum over ~45src-px sliding windows of mean support — the weakest
   * stretch of the whole tee→badge→basket route. Primary ranking signal. */
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

function main(): void {
  const args = process.argv.slice(2);
  const courseIdx = args.indexOf('--course');
  const onlyCourse = courseIdx >= 0 ? args.splice(courseIdx, 2)[1] : null;
  const [outDir] = args;
  if (!outDir) {
    console.error('Usage: tsx scripts/nuthing/pair-matrix.ts OUT_DIR [--course NAME]');
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });
  const model = JSON.parse(
    readFileSync('resources/nuthing-p2/digits/models/logistic.json', 'utf8'),
  ) as LogisticModel;
  const truthAll = loadTruth();

  const grand = { holes: 0, rank1: 0, rank3: 0 };
  for (const nm of Object.keys(truthAll)) {
    if (onlyCourse && nm !== onlyCourse) continue;
    const t0 = performance.now();
    const fullImage = decodeRgbaBin(`/workspace/nuthing-work/traces-py/${nm}.rgba.bin`);
    const viewport = detectMapViewport(fullImage);
    const image = cropRows(fullImage, viewport);
    const stage = runBadgeStage(image);
    const readings = readCourseBadges(stage, {
      name: 'logistic',
      scores: (m) => predictProbs(model, m),
    });
    const field: SupportField = computeRibbonSupport(image, {
      scale: FIELD_SCALE,
      orientations: FIELD_ORIENTATIONS,
      widthsSrc: FIELD_WIDTHS_SRC,
    });
    const cost = buildSupportCost(field.support);
    const fieldMs = performance.now() - t0;

    // --- Endpoint refinement -------------------------------------------------
    const badgeLabels = new Set(stage.badges.map((b) => b.label));
    const insideBadge = (c: (typeof stage.brightComponents)[number]): boolean =>
      stage.badges.some(
        (b) =>
          c.cx >= b.bboxX - 3 &&
          c.cx <= b.bboxX + b.bboxW + 3 &&
          c.cy >= b.bboxY - 3 &&
          c.cy <= b.bboxY + b.bboxH + 3,
      );
    const sprites = stage.brightComponents.filter(
      (c) =>
        c.bboxW >= 36 && c.bboxW <= 48 && c.bboxH >= 58 && c.bboxH <= 74 &&
        c.area >= 1300 && c.area <= 2100 && c.fill >= 0.45,
    );
    const zones = attributeBasketZones(stage.brightComponents, sprites);
    const tees = stage.brightComponents.filter(
      (c) =>
        !badgeLabels.has(c.label) &&
        !insideBadge(c) &&
        !sprites.includes(c) &&
        Math.min(c.bboxW, c.bboxH) >= 8 && Math.max(c.bboxW, c.bboxH) <= 42 &&
        c.area >= 80 && c.area <= 350 && c.fill >= 0.2 && c.fill <= 0.85,
    );
    const onRingCount = tees.filter((c) => zones.dashLabels.has(c.label)).length;
    // Basket endpoint: pole tip, BASKET_SPRITE_TIP_OFFSET_PX below the sprite.
    const basketPoints = sprites.map((c) => ({
      x: c.cx,
      y: c.cy + c.bboxH / 2 + 4,
      comp: c,
    }));
    const teePoints = tees.map((c) => ({
      x: c.cx,
      y: c.cy,
      comp: c,
      onRing: zones.dashLabels.has(c.label),
    }));
    console.log(
      `${nm}: viewport[${viewport.top},${viewport.bottom}) field ${field.width}x${field.height} ` +
        `(${fieldMs.toFixed(0)}ms) tees=${teePoints.length} (${onRingCount} on a C2D ring) ` +
        `baskets=${basketPoints.length} badges=${readings.filter((r) => r.label).length} labeled`,
    );

    // --- Per-badge matrix ----------------------------------------------------
    const clampCell = (v: number, hi: number): number => Math.max(0, Math.min(hi - 1, Math.round(v)));
    const toCell = (x: number, y: number): number =>
      clampCell(y / field.scale, field.height) * field.width + clampCell(x / field.scale, field.width);
    const supportAt = (cell: number): number => field.support[cell];

    interface BadgeMatrix {
      label: string;
      badge: { cx: number; cy: number };
      routeMs: number;
      legs: LegEvidence[];
      pairs: PairEvidence[];
      /** Pair indices sorted by primary score (worstWindowMean desc, supportMean tie-break). */
      rankOrder: number[];
    }
    const matrices: BadgeMatrix[] = [];
    const windowCells = Math.max(3, Math.round(WORST_WINDOW_SRC_PX / field.scale));

    for (const r of readings) {
      if (!r.label) continue;
      const tR = performance.now();
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
              failureReason: 'unreachable',
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
            failureReason: null,
          });
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
        label: r.label,
        badge: { cx: r.badge.cx, cy: r.badge.cy },
        routeMs: performance.now() - tR,
        legs: [...teeLegs, ...basketLegs],
        pairs,
        rankOrder,
      });
    }

    // --- Truth matching + ranks ---------------------------------------------
    const truth = truthAll[nm];
    const matchTee = (p: [number, number]): number => {
      let best = -1;
      let bestD = Infinity;
      teePoints.forEach((tp, i) => {
        const c = tp.comp;
        const inside =
          p[0] >= c.bboxX - TRUTH_TOL && p[0] <= c.bboxX + c.bboxW + TRUTH_TOL &&
          p[1] >= c.bboxY - TRUTH_TOL && p[1] <= c.bboxY + c.bboxH + TRUTH_TOL;
        if (!inside) return;
        const d = Math.hypot(tp.x - p[0], tp.y - p[1]);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      return best;
    };
    const matchBasket = (p: [number, number]): number => {
      let best = -1;
      let bestD = Infinity;
      basketPoints.forEach((bp, i) => {
        const c = bp.comp;
        const inside =
          p[0] >= c.bboxX - TRUTH_TOL && p[0] <= c.bboxX + c.bboxW + TRUTH_TOL &&
          p[1] >= c.bboxY - TRUTH_TOL && p[1] <= c.bboxY + c.bboxH + TRUTH_TOL;
        if (!inside) return;
        const d = Math.hypot(bp.x - p[0], bp.y - p[1]);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      return best;
    };

    interface HoleJudgment {
      hole: number;
      trueTee: number;
      trueBasket: number;
      rankPrimary: number;
      rankBySupportMean: number;
      rankByTotalScore: number;
      truePair: PairEvidence | null;
      topFalse: PairEvidence | null;
      topFalseSharesTee: boolean;
      topFalseSharesBasket: boolean;
      /** truth hole numbers owning the top-false endpoints, if any */
      topFalseTeeOwner: number | null;
      topFalseBasketOwner: number | null;
    }
    // Reverse truth ownership of candidate endpoints (for attribution).
    const teeOwner = new Map<number, number>();
    const basketOwner = new Map<number, number>();
    for (const h of truth) {
      const ti = matchTee([h.tee[0], h.tee[1] - viewport.top]);
      const bi = matchBasket([h.basket[0], h.basket[1] - viewport.top]);
      if (ti >= 0) teeOwner.set(ti, h.number);
      if (bi >= 0) basketOwner.set(bi, h.number);
    }

    const judgments: HoleJudgment[] = [];
    let teeRecall = 0;
    let basketRecall = 0;
    for (const h of truth) {
      const ti = matchTee([h.tee[0], h.tee[1] - viewport.top]);
      const bi = matchBasket([h.basket[0], h.basket[1] - viewport.top]);
      if (ti >= 0) teeRecall++;
      if (bi >= 0) basketRecall++;
      const m = matrices.find((mm) => Number(mm.label) === h.number);
      if (!m) continue;
      if (ti < 0 || bi < 0) {
        judgments.push({
          hole: h.number, trueTee: ti, trueBasket: bi,
          rankPrimary: -1, rankBySupportMean: -1, rankByTotalScore: -1,
          truePair: null, topFalse: m.pairs[m.rankOrder[0]] ?? null,
          topFalseSharesTee: false, topFalseSharesBasket: false,
          topFalseTeeOwner: null, topFalseBasketOwner: null,
        });
        continue;
      }
      const wantId = `T${ti}`;
      const wantB = `B${bi}`;
      const truePairIdx = m.pairs.findIndex((p) => p.teeId === wantId && p.basketId === wantB);
      const rankPrimary = m.rankOrder.indexOf(truePairIdx) + 1;
      const bySupportMean = m.pairs
        .map((_, i) => i)
        .sort((a, b) => m.pairs[b].supportMean - m.pairs[a].supportMean);
      const byTotal = m.pairs
        .map((_, i) => i)
        .sort((a, b) => m.pairs[a].totalScore - m.pairs[b].totalScore);
      const topFalseIdx = m.rankOrder.find((i) => i !== truePairIdx);
      const topFalse = topFalseIdx !== undefined ? m.pairs[topFalseIdx] : null;
      judgments.push({
        hole: h.number,
        trueTee: ti,
        trueBasket: bi,
        rankPrimary,
        rankBySupportMean: bySupportMean.indexOf(truePairIdx) + 1,
        rankByTotalScore: byTotal.indexOf(truePairIdx) + 1,
        truePair: m.pairs[truePairIdx],
        topFalse,
        topFalseSharesTee: topFalse ? topFalse.teeId === wantId : false,
        topFalseSharesBasket: topFalse ? topFalse.basketId === wantB : false,
        topFalseTeeOwner: topFalse ? teeOwner.get(Number(topFalse.teeId.slice(1))) ?? null : null,
        topFalseBasketOwner: topFalse
          ? basketOwner.get(Number(topFalse.basketId.slice(1))) ?? null
          : null,
      });
    }

    // --- Overlays ------------------------------------------------------------
    const base = new PNG({ width: field.width, height: field.height });
    for (let fy = 0; fy < field.height; fy++) {
      for (let fx = 0; fx < field.width; fx++) {
        let rr = 0;
        let gg = 0;
        let bb = 0;
        let cnt = 0;
        for (let dy = 0; dy < field.scale; dy++) {
          const sy = fy * field.scale + dy;
          if (sy >= image.height) continue;
          for (let dx = 0; dx < field.scale; dx++) {
            const sx = fx * field.scale + dx;
            if (sx >= image.width) continue;
            const p = (sy * image.width + sx) * 4;
            rr += image.data[p];
            gg += image.data[p + 1];
            bb += image.data[p + 2];
            cnt++;
          }
        }
        const o = (fy * field.width + fx) * 4;
        base.data[o] = cnt ? rr / cnt : 0;
        base.data[o + 1] = cnt ? gg / cnt : 0;
        base.data[o + 2] = cnt ? bb / cnt : 0;
        base.data[o + 3] = 255;
      }
    }
    const clone = (): PNG => {
      const p = new PNG({ width: field.width, height: field.height });
      base.data.copy(p.data);
      return p;
    };
    const markCell = (png: PNG, fx: number, fy: number, r: number, g: number, b: number, rad = 0): void => {
      for (let dy = -rad; dy <= rad; dy++) {
        for (let dx = -rad; dx <= rad; dx++) {
          const xx = fx + dx;
          const yy = fy + dy;
          if (xx < 0 || xx >= field.width || yy < 0 || yy >= field.height) continue;
          const p = (yy * field.width + xx) * 4;
          png.data[p] = r;
          png.data[p + 1] = g;
          png.data[p + 2] = b;
        }
      }
    };
    const drawPair = (png: PNG, m: BadgeMatrix, pair: PairEvidence, r: number, g: number, b: number): void => {
      const tl = m.legs.find((l) => l.endpointId === pair.teeId);
      const bl = m.legs.find((l) => l.endpointId === pair.basketId);
      for (const leg of [tl, bl]) {
        if (!leg) continue;
        for (let i = 0; i < leg.path.length; i += 2) markCell(png, leg.path[i], leg.path[i + 1], r, g, b);
      }
    };
    const markSrc = (png: PNG, x: number, y: number, r: number, g: number, b: number, rad = 2): void =>
      markCell(png, Math.round(x / field.scale), Math.round(y / field.scale), r, g, b, rad);

    const truePng = clone();
    for (const j of judgments) {
      const m = matrices.find((mm) => Number(mm.label) === j.hole);
      if (!m || !j.truePair) continue;
      const [r, g, b] =
        j.rankPrimary === 1 ? [0, 220, 0] : j.rankPrimary <= 3 ? [255, 220, 0] : [255, 60, 0];
      drawPair(truePng, m, j.truePair, r, g, b);
    }
    for (const m of matrices) markSrc(truePng, m.badge.cx, m.badge.cy, 255, 0, 0, 2);
    for (const h of truth) {
      markSrc(truePng, h.tee[0], h.tee[1] - viewport.top, 0, 230, 0, 1);
      markSrc(truePng, h.basket[0], h.basket[1] - viewport.top, 60, 120, 255, 1);
    }
    writeFileSync(`${outDir}/${nm}-true-pairs.png`, PNG.sync.write(truePng));

    for (const j of judgments) {
      if (j.rankPrimary >= 1 && j.rankPrimary <= 3) continue;
      const m = matrices.find((mm) => Number(mm.label) === j.hole);
      if (!m) continue;
      const png = clone();
      if (j.topFalse) drawPair(png, m, j.topFalse, 255, 40, 40);
      if (j.truePair) drawPair(png, m, j.truePair, 0, 220, 0);
      markSrc(png, m.badge.cx, m.badge.cy, 255, 0, 0, 2);
      const h = truth.find((x) => x.number === j.hole);
      if (h) {
        markSrc(png, h.tee[0], h.tee[1] - viewport.top, 0, 230, 0, 1);
        markSrc(png, h.basket[0], h.basket[1] - viewport.top, 60, 120, 255, 1);
      }
      writeFileSync(`${outDir}/${nm}-h${j.hole}-fail.png`, PNG.sync.write(png));
    }

    // --- Cache for replay ----------------------------------------------------
    writeFileSync(
      `${outDir}/${nm}-field.bin`,
      Buffer.from(field.support.buffer, field.support.byteOffset, field.support.byteLength),
    );
    // Best-orientation plane (radians, argmax over test orientations): the
    // replay boundary for strip-coherence refinements — a route that FOLLOWS
    // a ribbon moves parallel to bestTheta; a route that hops between
    // adjacent ribbons moves transverse to it while support stays high.
    writeFileSync(
      `${outDir}/${nm}-theta.bin`,
      Buffer.from(field.bestTheta.buffer, field.bestTheta.byteOffset, field.bestTheta.byteLength),
    );
    writeFileSync(
      `${outDir}/${nm}.json`,
      JSON.stringify(
        {
          course: nm,
          viewport,
          field: { width: field.width, height: field.height, scale: field.scale },
          params: {
            orientations: FIELD_ORIENTATIONS,
            widthsSrc: FIELD_WIDTHS_SRC,
            cost: '1+4*(1-s)^2',
            waiver: { radiusField: WAIVER_RADIUS_FIELD, maxCost: WAIVER_MAX_COST, appliedAt: 'badge only' },
            tau: SUPPORT_TAU,
            worstWindowSrcPx: WORST_WINDOW_SRC_PX,
          },
          endpoints: {
            tees: teePoints.map((p, i) => ({
              id: `T${i}`, x: p.x, y: p.y,
              bbox: [p.comp.bboxX, p.comp.bboxY, p.comp.bboxW, p.comp.bboxH],
              area: p.comp.area, fill: p.comp.fill, onRing: p.onRing,
            })),
            baskets: basketPoints.map((p, i) => ({
              id: `B${i}`, x: p.x, y: p.y,
              bbox: [p.comp.bboxX, p.comp.bboxY, p.comp.bboxW, p.comp.bboxH],
              area: p.comp.area, fill: p.comp.fill,
            })),
            onRingCount,
          },
          badges: matrices.map((m) => ({
            label: m.label, cx: m.badge.cx, cy: m.badge.cy, routeMs: Math.round(m.routeMs),
            legs: m.legs,
            pairs: m.pairs,
            rankOrder: m.rankOrder,
          })),
          judgments,
        },
        (_k, v) => (v === Infinity ? 'Infinity' : v),
      ),
    );

    // --- Console report ------------------------------------------------------
    const ranked = judgments.filter((j) => j.rankPrimary >= 1);
    const r1 = ranked.filter((j) => j.rankPrimary === 1).length;
    const r3 = ranked.filter((j) => j.rankPrimary <= 3).length;
    grand.holes += ranked.length;
    grand.rank1 += r1;
    grand.rank3 += r3;
    console.log(
      `${nm}: endpointRecall tee=${teeRecall}/${truth.length} basket=${basketRecall}/${truth.length} | ` +
        `rank1=${r1}/${ranked.length} rank<=3=${r3}/${ranked.length} | ` +
        `routeMs/badge=${(matrices.reduce((a, m) => a + m.routeMs, 0) / Math.max(1, matrices.length)).toFixed(0)}`,
    );
    for (const j of judgments) {
      const tag =
        j.rankPrimary < 0
          ? 'ENDPOINT-MISS'
          : j.rankPrimary === 1
            ? 'ok'
            : j.rankPrimary <= 3
              ? `rank${j.rankPrimary}`
              : `FAIL rank${j.rankPrimary}`;
      const tp = j.truePair;
      const tf = j.topFalse;
      console.log(
        `  h${j.hole}: ${tag}` +
          (tp
            ? ` true[ww=${tp.worstWindowMean.toFixed(2)} mean=${tp.supportMean.toFixed(2)} sf=${tp.supportedFraction.toFixed(2)} eff=${tp.efficiency.toFixed(2)}]`
            : '') +
          (tf && j.rankPrimary !== 1
            ? ` topFalse ${tf.teeId}${j.topFalseTeeOwner ? `(h${j.topFalseTeeOwner}tee)` : ''}/` +
              `${tf.basketId}${j.topFalseBasketOwner ? `(h${j.topFalseBasketOwner}bkt)` : ''}` +
              `[ww=${tf.worstWindowMean.toFixed(2)} mean=${tf.supportMean.toFixed(2)}]` +
              `${j.topFalseSharesTee ? ' sharesTee' : ''}${j.topFalseSharesBasket ? ' sharesBasket' : ''}`
            : ''),
      );
    }
  }
  console.log(
    `TOTAL rank1=${grand.rank1}/${grand.holes} rank<=3=${grand.rank3}/${grand.holes}`,
  );
}

main();
