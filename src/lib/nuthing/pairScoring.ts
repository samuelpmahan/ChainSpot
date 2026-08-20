/**
 * NuThing P2 pair re-scoring + assignment — the frozen dev72 stack, extracted
 * verbatim from scripts/nuthing/pair-matrix-replay.ts so the replay script
 * and the in-browser Course Vision producer run the SAME code. Every knob
 * defaults to its dev72 value; the script threads its CLI/env overrides
 * through `ScoringOptions`, the browser uses the defaults.
 *
 * Layer lineage (measured on the dev corpus before wiring — see
 * docs/nuthing-p2/cx-catalog.md):
 *  - aligned strip-coherence re-scoring (p=2, window 90 src px)
 *  - --zones: basket-zone furniture attribution discount (tangential-only on
 *    rings, unconditional inside the sprite silhouette)
 *  - --simple: canonical-form doubling penalty ×(1−overlap)²
 *  - --invariants: tee-orientation gaussian (σ=12°), badge chord-fraction
 *    band 0.36±0.19 (σ=0.15), collinearity BONUS 1+0.6·exp(−(deg/2)²)
 *  - --identity: basket matched-filter prior (floor 0.4), recovered-tee 0.7
 *  - --zfit (flag-gated OFF at dev72): salvage-only ≤2-bend polyline rescue
 *  - --abearing (flag-gated OFF, measured harmful): agreement-bearing bonus
 *  - --assign: greedy seed (decisiveness order) + single-move + two-badge
 *    exchange from 3 deterministic starts, raw scores.
 */

export interface CacheLeg {
  endpointId: string;
  geodesic: number | string;
  path: number[];
  reachable: boolean;
}
export interface CachePair {
  pairId: string;
  teeId: string;
  basketId: string;
  worstWindowMean: number;
  supportMean: number;
}
export interface CacheBadge {
  label: string;
  cx: number;
  cy: number;
  legs: CacheLeg[];
  pairs: CachePair[];
}
export interface ScoringEndpoints {
  tees: { id: string; x: number; y: number; onRing: boolean; angle?: number | null; tier?: string }[];
  baskets: { id: string; x: number; y: number; score?: number }[];
}
export interface ScoringCourse {
  field: { width: number; height: number; scale: number };
  endpoints: ScoringEndpoints;
  badges: CacheBadge[];
}

export interface ScoringOptions {
  alignPow?: number;
  windowSrcPx?: number;
  /** 'aligned' | 'combo' | 'mean' */
  scoreMode?: string;
  zones?: boolean;
  simple?: boolean;
  invariants?: boolean;
  identity?: boolean;
  identFloor?: number;
  recoveredTeePrior?: number;
  fracCenter?: number;
  fracHalfWidth?: number;
  collinBonus?: number;
  collinSigma?: number;
  zfit?: boolean;
  corridorWidthPx?: number;
  zfitFactor?: number;
  zfitF1?: number;
  zfitF2?: number;
  zfitTopK?: number;
  zfitRescueMax?: number;
  /** basketId -> agreed approach bearing (deg); presence enables --abearing. */
  agreedBearing?: ReadonlyMap<string, number>;
  abW?: number;
  abSigma?: number;
}

export interface Rescored {
  teeId: string;
  basketId: string;
  alignedWorstWindow: number;
  alignedMean: number;
  score: number;
}

const ZONE_DISCOUNT = 0.4;
const ALIGN_SIGMA_DEG = 12;
const FRAC_SIGMA = 0.15;

/** dev72 stack defaults (the values every knob was frozen at). */
export const DEV72_SCORING: ScoringOptions = Object.freeze({
  alignPow: 2,
  windowSrcPx: 90,
  scoreMode: 'aligned',
  zones: true,
  simple: true,
  invariants: true,
  identity: true
});

export function rescoreCourse(
  cache: ScoringCourse,
  support: Float32Array,
  theta: Float32Array,
  options: ScoringOptions = {}
): Map<string, Rescored[]> {
  const {
    alignPow = 2,
    windowSrcPx = 90,
    scoreMode = 'aligned',
    zones = false,
    simple = false,
    invariants = false,
    identity = false,
    identFloor = 0.4,
    recoveredTeePrior = 0.7,
    fracCenter = 0.36,
    fracHalfWidth = 0.19,
    collinBonus = 0.6,
    collinSigma = 2,
    zfit = false,
    corridorWidthPx = 37,
    zfitFactor = 0.9,
    zfitF1 = 0.9,
    zfitF2 = 0.8,
    zfitTopK = 80,
    zfitRescueMax = 0.28,
    agreedBearing,
    abW = 0.5,
    abSigma = 15
  } = options;
  const abearing = agreedBearing !== undefined;
  const { width: w, height: h, scale } = cache.field;
  const windowCells = Math.max(3, Math.round(windowSrcPx / scale));

  // Per-cell, per-basket zone-furniture attribution factor (exemption of the
  // pair's own endpoint basket is applied per leg).
  const basketCenters = cache.endpoints.baskets.map((b) => ({ x: b.x, y: b.y }));
  const zoneOf = (cell: number, basket: { x: number; y: number }): number => {
    const cx = ((cell % w) + 0.5) * scale;
    const cy = (Math.floor(cell / w) + 0.5) * scale;
    const dx = cx - basket.x;
    const dy = cy - basket.y;
    const d = Math.hypot(dx, dy);
    // Sprite silhouette: unconditional near-ceiling false positive.
    if (d <= 35) return ZONE_DISCOUNT;
    const onC2D = Math.abs(d - 84) <= 12;
    const onC1S = Math.abs(d - 44) <= 8;
    if (!onC2D && !onC1S) return 1;
    // Tangency: ribbon direction (cos t, sin t) vs radial unit.
    const t = theta[cell];
    const radial = Math.abs((dx * Math.cos(t) + dy * Math.sin(t)) / Math.max(d, 1e-9));
    return radial <= 0.5 ? ZONE_DISCOUNT : 1; // within 30° of tangential
  };

  // Aligned samples along one leg's cached path (badge-first order).
  const alignedLeg = (leg: CacheLeg, exemptBasket: number): Float32Array => {
    const m = leg.path.length / 2;
    const out = new Float32Array(m);
    for (let i = 0; i < m; i++) {
      const x = leg.path[i * 2];
      const y = leg.path[i * 2 + 1];
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(m - 1, i + 1);
      const dx = leg.path[i1 * 2] - leg.path[i0 * 2];
      const dy = leg.path[i1 * 2 + 1] - leg.path[i0 * 2 + 1];
      const len = Math.hypot(dx, dy);
      const cell = y * w + x;
      if (len < 1e-9) {
        out[i] = support[cell];
        continue;
      }
      const t = theta[cell];
      const align = Math.abs((dx * Math.cos(t) + dy * Math.sin(t)) / len);
      let s = support[cell] * Math.pow(align, alignPow);
      if (zones) {
        for (let b = 0; b < basketCenters.length; b++) {
          if (b === exemptBasket) continue;
          const f = zoneOf(cell, basketCenters[b]);
          if (f < 1) {
            s *= f;
            break;
          }
        }
      }
      out[i] = s;
    }
    return out;
  };

  const alignedSegment = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    exemptBasket: number,
    out: number[]
  ): void => {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.round(len / scale));
    const dx = (x1 - x0) / len;
    const dy = (y1 - y0) / len;
    for (let i = 1; i <= steps; i++) {
      const px = x0 + (x1 - x0) * (i / steps);
      const py = y0 + (y1 - y0) * (i / steps);
      const cx = Math.min(w - 1, Math.max(0, Math.round(px / scale)));
      const cy = Math.min(h - 1, Math.max(0, Math.round(py / scale)));
      const cell = cy * w + cx;
      const t = theta[cell];
      const align = Math.abs(dx * Math.cos(t) + dy * Math.sin(t));
      let s = support[cell] * Math.pow(align, alignPow);
      if (zones) {
        for (let b = 0; b < basketCenters.length; b++) {
          if (b === exemptBasket) continue;
          const f = zoneOf(cell, basketCenters[b]);
          if (f < 1) {
            s *= f;
            break;
          }
        }
      }
      out.push(s);
    }
  };
  const worstWindowOf = (samples: number[]): number => {
    const count = samples.length;
    if (count === 0) return 0;
    let sum = 0;
    for (const s of samples) sum += s;
    if (count <= windowCells) return sum / count;
    let acc = 0;
    for (let i = 0; i < windowCells; i++) acc += samples[i];
    let worst = acc / windowCells;
    for (let i = windowCells; i < count; i++) {
      acc += samples[i] - samples[i - windowCells];
      const m = acc / windowCells;
      if (m < worst) worst = m;
    }
    return worst;
  };
  const zfitWorst = (
    tee: { x: number; y: number },
    bc: { cx: number; cy: number },
    basket: { x: number; y: number },
    exemptBasket: number,
    Wc: number
  ): number => {
    const dBx = bc.cx - tee.x;
    const dBy = bc.cy - tee.y;
    const dBadge = Math.hypot(dBx, dBy);
    if (dBadge < 1e-6) return 0;
    const u1x = dBx / dBadge;
    const u1y = dBy / dBadge;
    const chord = Math.hypot(basket.x - tee.x, basket.y - tee.y);
    let best = 0;
    for (let t1 = dBadge + 8; t1 <= Math.min(chord * 0.85, dBadge + 220); t1 += 14) {
      const p1x = tee.x + u1x * t1;
      const p1y = tee.y + u1y * t1;
      for (const deltaDeg of [-60, -45, -30, -20, 0, 20, 30, 45, 60]) {
        const d = (deltaDeg * Math.PI) / 180;
        const u2x = u1x * Math.cos(d) - u1y * Math.sin(d);
        const u2y = u1x * Math.sin(d) + u1y * Math.cos(d);
        for (const L2 of deltaDeg === 0 ? [0] : [0.8 * Wc, 1.6 * Wc, 3 * Wc]) {
          const p2x = p1x + u2x * L2;
          const p2y = p1y + u2y * L2;
          const tail = Math.hypot(basket.x - p2x, basket.y - p2y);
          if (t1 + L2 + tail > 1.4 * chord) continue;
          const samples: number[] = [];
          alignedSegment(tee.x, tee.y, p1x, p1y, exemptBasket, samples);
          if (L2 > 0) alignedSegment(p1x, p1y, p2x, p2y, exemptBasket, samples);
          alignedSegment(p2x, p2y, basket.x, basket.y, exemptBasket, samples);
          // Occam prior: each bend costs — honest Z-corridors clear the
          // discount, shopped ones don't.
          const bends = deltaDeg === 0 ? 0 : L2 > 0 ? 2 : 1;
          const wv = worstWindowOf(samples) * (bends === 0 ? 1 : bends === 1 ? zfitF1 : zfitF2);
          if (wv > best) best = wv;
        }
      }
    }
    return best;
  };

  const rescoredByBadge = new Map<string, Rescored[]>();
  for (const badge of cache.badges) {
    // Tee legs never get a zone exemption; each basket leg exempts only its
    // own endpoint basket's zone.
    const legAligned = new Map<string, Float32Array>();
    for (const leg of badge.legs) {
      if (!leg.reachable) continue;
      const exempt = leg.endpointId.startsWith('B') ? Number(leg.endpointId.slice(1)) : -1;
      legAligned.set(leg.endpointId, alignedLeg(leg, exempt));
    }
    const bxCell = Math.round(badge.cx / scale);
    const byCell = Math.round(badge.cy / scale);
    const legCellSet = new Map<string, Set<number>>();
    const legOutsideCount = new Map<string, number>();
    if (simple) {
      for (const leg of badge.legs) {
        if (!leg.reachable) continue;
        const set = new Set<number>();
        let outside = 0;
        for (let i = 0; i < leg.path.length; i += 2) {
          const x = leg.path[i];
          const y = leg.path[i + 1];
          if (Math.hypot(x - bxCell, y - byCell) <= 8) continue;
          set.add(y * w + x);
          outside++;
        }
        legCellSet.set(leg.endpointId, set);
        legOutsideCount.set(leg.endpointId, outside);
      }
    }
    const rows: Rescored[] = [];
    for (const pair of badge.pairs) {
      const tl = legAligned.get(pair.teeId);
      const bl = legAligned.get(pair.basketId);
      if (!tl || !bl) {
        rows.push({
          teeId: pair.teeId,
          basketId: pair.basketId,
          alignedWorstWindow: 0,
          alignedMean: 0,
          score: 0
        });
        continue;
      }
      // tee→badge→basket: reverse tee leg, drop duplicated badge cell.
      const count = tl.length + bl.length - 1;
      const samples = new Float32Array(count);
      for (let i = 0; i < tl.length; i++) samples[i] = tl[tl.length - 1 - i];
      for (let i = 1; i < bl.length; i++) samples[tl.length + i - 1] = bl[i];
      let sum = 0;
      for (let i = 0; i < count; i++) sum += samples[i];
      let worst = 1;
      if (count <= windowCells) {
        worst = sum / count;
      } else {
        let acc = 0;
        for (let i = 0; i < windowCells; i++) acc += samples[i];
        worst = acc / windowCells;
        for (let i = windowCells; i < count; i++) {
          acc += samples[i] - samples[i - windowCells];
          const m = acc / windowCells;
          if (m < worst) worst = m;
        }
      }
      let score =
        scoreMode === 'combo'
          ? worst * pair.worstWindowMean
          : scoreMode === 'mean'
            ? sum / count
            : worst;
      if (identity) {
        const basket = cache.endpoints.baskets[Number(pair.basketId.slice(1))];
        if (basket && typeof basket.score === 'number') {
          score *= Math.min(1, Math.max(identFloor, (basket.score - 0.2) / 0.5));
        }
        // Recovered-tier tees are speculative pool members and must not
        // outbid detector-verified tees on healthy holes (swept 0.5/0.7/0.85
        // on dev; 0.7).
        const teeT = cache.endpoints.tees[Number(pair.teeId.slice(1))];
        if (teeT && teeT.tier === 'recovered') {
          score *= recoveredTeePrior;
        }
      }
      if (invariants) {
        const tee = cache.endpoints.tees[Number(pair.teeId.slice(1))];
        const basket = cache.endpoints.baskets[Number(pair.basketId.slice(1))];
        if (tee && basket) {
          if (tee.angle !== null && tee.angle !== undefined) {
            const dir = Math.atan2(badge.cy - tee.y, badge.cx - tee.x);
            let d = Math.abs((((tee.angle - dir) % Math.PI) + Math.PI) % Math.PI);
            d = Math.min(d, Math.PI - d) * (180 / Math.PI);
            score *= Math.exp(-((d / ALIGN_SIGMA_DEG) ** 2));
          }
          const vx = basket.x - tee.x;
          const vy = basket.y - tee.y;
          const vv = vx * vx + vy * vy;
          if (vv > 1e-9) {
            const frac = ((badge.cx - tee.x) * vx + (badge.cy - tee.y) * vy) / vv;
            const excess = Math.max(0, Math.abs(frac - fracCenter) - fracHalfWidth);
            score *= Math.exp(-((excess / FRAC_SIGMA) ** 2));
            // Perfect-line BONUS (never a penalty — dogleg true pairs have
            // the badge legitimately off the chord).
            const dTB = Math.atan2(vy, vx);
            const dBadge = Math.atan2(badge.cy - tee.y, badge.cx - tee.x);
            let dc = Math.abs(dBadge - dTB) % (2 * Math.PI);
            if (dc > Math.PI) dc = 2 * Math.PI - dc;
            const collinDeg = (dc * 180) / Math.PI;
            score *= 1 + collinBonus * Math.exp(-((collinDeg / collinSigma) ** 2));
          }
        }
      }
      if (abearing) {
        const ab = agreedBearing!.get(pair.basketId);
        const basketAb = cache.endpoints.baskets[Number(pair.basketId.slice(1))];
        const teeAb = cache.endpoints.tees[Number(pair.teeId.slice(1))];
        if (ab !== undefined && basketAb && teeAb) {
          // Only on STRAIGHT pairs (collinear < 2 deg): there basket→badge
          // provably IS the approach direction; on doglegs the proxy misfires.
          const dTB2 = Math.atan2(basketAb.y - teeAb.y, basketAb.x - teeAb.x);
          const dBadge2 = Math.atan2(badge.cy - teeAb.y, badge.cx - teeAb.x);
          let dc2 = Math.abs(dBadge2 - dTB2) % (2 * Math.PI);
          if (dc2 > Math.PI) dc2 = 2 * Math.PI - dc2;
          if ((dc2 * 180) / Math.PI < 2) {
            const brg = (Math.atan2(badge.cy - basketAb.y, badge.cx - basketAb.x) * 180) / Math.PI;
            let d = Math.abs(brg - ab) % 360;
            if (d > 180) d = 360 - d;
            score *= 1 + abW * Math.exp(-((d / abSigma) ** 2));
          }
        }
      }
      if (simple) {
        const teeCells = legCellSet.get(pair.teeId);
        const basketLeg = badge.legs.find((l) => l.endpointId === pair.basketId);
        const denom = legOutsideCount.get(pair.basketId) ?? 0;
        if (teeCells && basketLeg && denom > 0) {
          let shared = 0;
          for (let i = 0; i < basketLeg.path.length; i += 2) {
            const x = basketLeg.path[i];
            const y = basketLeg.path[i + 1];
            if (Math.hypot(x - bxCell, y - byCell) <= 8) continue;
            if (teeCells.has(y * w + x)) shared++;
          }
          const overlap = shared / denom;
          score *= (1 - overlap) * (1 - overlap);
        }
      }
      rows.push({
        teeId: pair.teeId,
        basketId: pair.basketId,
        alignedWorstWindow: worst,
        alignedMean: sum / count,
        score
      });
    }
    if (zfit) {
      // Rescue pass on the strongest rows: layers multiplied `worst` into
      // `score`, so lifting worst -> max(worst, F * zfitWorst) rescales the
      // score by the same layer product without re-running the layers.
      const order = rows
        .map((_, i) => i)
        .sort((a, b) => rows[b].score - rows[a].score)
        .slice(0, zfitTopK);
      for (const i of order) {
        const row = rows[i];
        if (row.alignedWorstWindow <= 0 || row.score <= 0) continue;
        // Salvage-only: rescue pairs whose ROUTE drowned them; healthy routed
        // scores get no boost (unconditional rescue measurably let false
        // pairs shop for 2-bend bridges).
        if (row.alignedWorstWindow >= zfitRescueMax) continue;
        const tee = cache.endpoints.tees[Number(row.teeId.slice(1))];
        const basket = cache.endpoints.baskets[Number(row.basketId.slice(1))];
        if (!tee || !basket) continue;
        const zw =
          zfitWorst(tee, badge, basket, Number(row.basketId.slice(1)), corridorWidthPx) * zfitFactor;
        if (zw > row.alignedWorstWindow) {
          const layerProduct = row.score / row.alignedWorstWindow;
          row.alignedWorstWindow = zw;
          row.score = zw * layerProduct;
        }
      }
    }
    rescoredByBadge.set(badge.label, rows);
  }
  return rescoredByBadge;
}

/**
 * One pair per badge, 1:1 on tees and baskets, maximize total score. Greedy
 * seed in per-badge decisiveness order + single-badge moves + two-badge
 * exchange moves, from 3 deterministic start orders, keeping the highest
 * total. Raw scores compare across badges (per-badge normalization measured
 * WORSE, 38 vs 42 exact).
 */
export function assignPairs(
  rescoredByBadge: ReadonlyMap<string, Rescored[]>
): Map<string, Rescored | null> {
  const labels = [...rescoredByBadge.keys()];
  const margin = (l: string): number => {
    const rows = [...rescoredByBadge.get(l)!].sort((a, b) => b.score - a.score);
    const top = rows[0];
    if (!top) return 0;
    const rival = rows.find((r) => r.teeId !== top.teeId && r.basketId !== top.basketId);
    return top.score - (rival ? rival.score : 0);
  };
  const solveFrom = (order: string[]): Map<string, Rescored | null> => {
    const pick = new Map<string, Rescored | null>(labels.map((l) => [l, null]));
    const tUsed = new Set<string>();
    const bUsed = new Set<string>();
    for (const l of order) {
      let best: Rescored | null = null;
      for (const row of rescoredByBadge.get(l)!) {
        if (tUsed.has(row.teeId) || bUsed.has(row.basketId)) continue;
        if (!best || row.score > best.score) best = row;
      }
      if (!best) continue;
      pick.set(l, best);
      tUsed.add(best.teeId);
      bUsed.add(best.basketId);
    }
    const K = 12;
    const topRows = new Map(
      labels.map((l) => [
        l,
        [...rescoredByBadge.get(l)!].sort((a, b) => b.score - a.score).slice(0, 60)
      ])
    );
    let improved = true;
    let guard = 0;
    while (improved && guard++ < 60) {
      improved = false;
      // Single-badge move.
      for (const l of labels) {
        const cur = pick.get(l);
        if (cur) {
          tUsed.delete(cur.teeId);
          bUsed.delete(cur.basketId);
        }
        let best: Rescored | null = null;
        for (const row of topRows.get(l)!) {
          if (tUsed.has(row.teeId) || bUsed.has(row.basketId)) continue;
          if (!best || row.score > best.score) best = row;
        }
        if (best && (!cur || best.score > cur.score + 1e-9)) {
          pick.set(l, best);
          improved = true;
        } else if (cur) {
          pick.set(l, cur);
        }
        const now = pick.get(l);
        if (now) {
          tUsed.add(now.teeId);
          bUsed.add(now.basketId);
        }
      }
      // Two-badge exchange: free both badges' endpoints, try top-K rows for
      // each jointly, keep the best feasible combination.
      for (let i = 0; i < labels.length; i++) {
        for (let jdx = i + 1; jdx < labels.length; jdx++) {
          const li = labels[i];
          const lj = labels[jdx];
          const ci = pick.get(li);
          const cj = pick.get(lj);
          const base = (ci?.score ?? 0) + (cj?.score ?? 0);
          for (const c of [ci, cj]) {
            if (c) {
              tUsed.delete(c.teeId);
              bUsed.delete(c.basketId);
            }
          }
          let bestPair: [Rescored | null, Rescored | null] = [ci ?? null, cj ?? null];
          let bestTotal = base;
          const rowsI = topRows.get(li)!.slice(0, K);
          const rowsJ = topRows.get(lj)!.slice(0, K);
          for (const ri of rowsI) {
            if (tUsed.has(ri.teeId) || bUsed.has(ri.basketId)) continue;
            for (const rj of rowsJ) {
              if (rj.teeId === ri.teeId || rj.basketId === ri.basketId) continue;
              if (tUsed.has(rj.teeId) || bUsed.has(rj.basketId)) continue;
              const total = ri.score + rj.score;
              if (total > bestTotal + 1e-9) {
                bestTotal = total;
                bestPair = [ri, rj];
              }
            }
          }
          if (bestPair[0] !== ci || bestPair[1] !== cj) improved = true;
          pick.set(li, bestPair[0]);
          pick.set(lj, bestPair[1]);
          for (const c of bestPair) {
            if (c) {
              tUsed.add(c.teeId);
              bUsed.add(c.basketId);
            }
          }
        }
      }
    }
    return pick;
  };
  const total = (pick: Map<string, Rescored | null>): number =>
    [...pick.values()].reduce((a, r) => a + (r?.score ?? 0), 0);
  const marginOrder = [...labels].sort((a, b) => margin(b) - margin(a));
  const starts: string[][] = [marginOrder, [...labels], [...labels].reverse()];
  let bestPick = solveFrom(starts[0]);
  for (const order of starts.slice(1)) {
    const p = solveFrom(order);
    if (total(p) > total(bestPick)) bestPick = p;
  }
  return bestPick;
}
