// Replay refinement over the cached tee×basket evidence matrix:
// STRIP-COHERENCE (bacon) re-scoring.
//
// The baseline matrix (scripts/nuthing/pair-matrix.ts, see
// docs/nuthing-p2/pair-matrix-baseline.md) showed that 46/53 strongest
// false competitors are real endpoints of adjacent holes reached by riding
// a NEIGHBORING ribbon or the basket-zone carpet — real support, wrong
// strip. A ribbon is an elongated, oriented structure: a route that follows
// its strip moves parallel to the field's best orientation; a route that
// hops between adjacent parallel strips moves transverse to it while raw
// support stays high. This replay re-scores every cached pair with
// orientation-ALIGNED support samples
//     s'_i = s_i * |cos(dir_i - bestTheta_i)|^p
// and re-ranks. Nothing is re-detected and nothing is re-routed: inputs are
// exactly the cached legs, support plane and theta plane — the replay
// boundary working as designed.
//
// Usage: npx tsx scripts/nuthing/pair-matrix-replay.ts CACHE_DIR [--p N] [--window PX] [--render]

import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { detectMapViewport, cropRows } from '../../src/lib/nuthing/viewport';
import { decodeRgbaBin } from './decode';

interface CacheLeg {
  endpointId: string;
  geodesic: number | string;
  path: number[];
  reachable: boolean;
}
interface CachePair {
  pairId: string;
  teeId: string;
  basketId: string;
  worstWindowMean: number;
  supportMean: number;
}
interface CacheBadge {
  label: string;
  cx: number;
  cy: number;
  legs: CacheLeg[];
  pairs: CachePair[];
}
interface CacheJudgment {
  hole: number;
  trueTee: number;
  trueBasket: number;
  rankPrimary: number;
}
interface CacheCourse {
  course: string;
  viewport: { top: number; bottom: number };
  field: { width: number; height: number; scale: number };
  endpoints: {
    tees: { id: string; x: number; y: number; onRing: boolean; angle?: number | null }[];
    baskets: { id: string; x: number; y: number }[];
  };
  badges: CacheBadge[];
  judgments: CacheJudgment[];
}

const COURSES = ['DashsTrack-full', 'HeritagePark-full', 'Lenard-full', 'TowneLake-full'];

function main(): void {
  const args = process.argv.slice(2);
  const grab = (flag: string, dflt: number): number => {
    const i = args.indexOf(flag);
    return i >= 0 ? Number(args.splice(i, 2)[1]) : dflt;
  };
  const alignPow = grab('--p', 2);
  const windowSrcPx = grab('--window', 90);
  const scoreIdx = args.indexOf('--score');
  // 'aligned' ranks by the aligned worst window alone; 'combo' multiplies it
  // by the baseline (unaligned) worst window, so a pair must BOTH stay on
  // one strip and never cross truly unsupported ground.
  const scoreMode = scoreIdx >= 0 ? args.splice(scoreIdx, 2)[1] : 'aligned';
  const renderIdx = args.indexOf('--render');
  const render = renderIdx >= 0 ? (args.splice(renderIdx, 1), true) : false;
  // Replay layer 2 — basket-zone attribution: support that is attributable
  // to a basket zone's own furniture (C2D dash ring at ~84 src px, C1S solid
  // ring at ~44, sprite silhouette within ~35 of the sprite center) is
  // discounted when the zone belongs to a basket that is NOT the pair's
  // endpoint. Ring bands are discounted only where the local bestTheta runs
  // TANGENTIALLY to the ring — a ribbon genuinely crossing a ring is radial
  // there and keeps its support. Ring riding is tangential (aligned), which
  // is exactly why strip-coherence alone cannot catch it.
  const zonesIdx = args.indexOf('--zones');
  const zones = zonesIdx >= 0 ? (args.splice(zonesIdx, 1), true) : false;
  const ZONE_DISCOUNT = 0.4;
  // Replay layer 3 — simple-path (canonical-form) discipline: in the form
  // tee→badge→basket the badge is an INTERIOR waypoint, so the pair's path
  // must pass THROUGH it. When a badge routes to a neighboring hole's
  // complete (tee, basket) pair, both legs leave the badge on the same
  // transverse stub and ride the same foreign ribbon — the concatenated
  // path doubles back over itself. Doubling is measured as the fraction of
  // basket-leg cells (outside the badge waiver disk) also visited by the
  // tee leg; measured on dev truth it is 0.00 for ALL 61 true pairs and up
  // to 0.88 for strongest false competitors. Score ×= (1−overlap)².
  const simpleIdx = args.indexOf('--simple');
  const simple = simpleIdx >= 0 ? (args.splice(simpleIdx, 1), true) : false;
  // Replay layer 4 — global assignment: each tee and each basket belongs to
  // at most one hole. Applied LAST, over evidence the earlier layers made as
  // honest as possible (never as primary pairing logic): pick one pair per
  // badge maximizing total score under 1:1 uniqueness, via greedy seeding +
  // 2-swap local search. Reports exact-assignment accuracy per course.
  const assignIdx = args.indexOf('--assign');
  const assign = assignIdx >= 0 ? (args.splice(assignIdx, 1), true) : false;
  // Replay layer 5 — P3 domain invariants ("a teepad points directly at its
  // badge; a badge is always before any bend"), both validated on dev truth
  // in THIS pipeline's frame before use:
  //  * tee orientation: ring-tier tees carry the hole principal axis; for
  //    true (tee, badge) the axis points at the badge with median error
  //    1.1°, p90 2.65°, max 11.3° (n=59); false badges: median 38°, p10
  //    6.5°. Penalty is gaussian in the angle error with σ=6°.
  //  * badge longitudinal position: the badge projects onto tee→basket at
  //    0.19–0.54 (median 0.51, n=66; matches NUTHING-P3's independent
  //    0.17–0.54, n=72). Penalty is gaussian in the excess outside
  //    0.45 ± 0.15 with σ=0.15.
  const invIdx = args.indexOf('--invariants');
  const invariants = invIdx >= 0 ? (args.splice(invIdx, 1), true) : false;
  // Replay layer 6 — endpoint identity evidence: the basket detector's
  // matched-filter score is cached per basket (clean sprite ~0.95+, occluded
  // real ~0.3-0.65, false positives cluster ~0.28-0.6 too — so this is a
  // soft weight, not a gate). It exists to stop uniqueness overflow from
  // parking wrong badges on low-score sprite false positives.
  const identIdx = args.indexOf('--identity');
  const identity = identIdx >= 0 ? (args.splice(identIdx, 1), true) : false;
  const IDENT_FLOOR = grab('--ident-floor', 0.4);
  // --emit: write the consumable product — per-course hole→(tee, basket)
  // assignments in FULL-FRAME pixel coordinates + a verification overlay.
  const emitIdx = args.indexOf('--emit');
  const emit = emitIdx >= 0 ? (args.splice(emitIdx, 1), true) : false;
  const ALIGN_SIGMA_DEG = 12;
  const FRAC_CENTER = 0.45;
  const FRAC_HALF_WIDTH = 0.15;
  const FRAC_SIGMA = 0.15;
  const [cacheDir] = args;
  if (!cacheDir) {
    console.error('Usage: tsx scripts/nuthing/pair-matrix-replay.ts CACHE_DIR [--p N] [--window PX] [--render]');
    process.exit(1);
  }

  const grand = { n: 0, r1: 0, r3: 0, baseR1: 0, baseR3: 0, assigned: 0, assignedN: 0 };
  for (const nm of COURSES) {
    const cache = JSON.parse(readFileSync(`${cacheDir}/${nm}.json`, 'utf8')) as CacheCourse;
    const { width: w, height: h, scale } = cache.field;
    const support = new Float32Array(readFileSync(`${cacheDir}/${nm}-field.bin`).buffer.slice(0));
    const theta = new Float32Array(readFileSync(`${cacheDir}/${nm}-theta.bin`).buffer.slice(0));
    const windowCells = Math.max(3, Math.round(windowSrcPx / scale));

    // Per-cell, per-basket zone-furniture attribution factor (computed once;
    // exemption of the pair's own endpoint basket is applied per leg).
    // zoneFactor[b][cell] = ZONE_DISCOUNT where cell's support is attributable
    // to basket b's furniture, else 1.
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
    // exemptBasket: index of the pair's own endpoint basket (its zone is the
    // leg's legitimate terminal approach), or -1.
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
        // Ribbon runs along (cos t, sin t); alignment is |cos| of the angle
        // between travel direction and the strip direction (mod pi).
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

    interface Rescored {
      teeId: string;
      basketId: string;
      alignedWorstWindow: number;
      alignedMean: number;
      score: number;
    }
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
          rows.push({ teeId: pair.teeId, basketId: pair.basketId, alignedWorstWindow: 0, alignedMean: 0, score: 0 });
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
          const basket = cache.endpoints.baskets[Number(pair.basketId.slice(1))] as {
            score?: number;
          };
          if (basket && typeof basket.score === 'number') {
            score *= Math.min(1, Math.max(IDENT_FLOOR, (basket.score - 0.2) / 0.5));
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
              const excess = Math.max(0, Math.abs(frac - FRAC_CENTER) - FRAC_HALF_WIDTH);
              score *= Math.exp(-((excess / FRAC_SIGMA) ** 2));
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
          score,
        });
      }
      rescoredByBadge.set(badge.label, rows);
    }

    let pristineBase: Buffer | null = null;
    let assignedForOverlay: Map<string, Rescored | null> | null = null;
    let n = 0;
    let r1 = 0;
    let r3 = 0;
    let baseR1 = 0;
    let baseR3 = 0;
    const fails: string[] = [];
    const rankByHole = new Map<number, number>();
    for (const j of cache.judgments) {
      if (j.rankPrimary < 1) continue;
      const rows = rescoredByBadge.get(String(j.hole));
      if (!rows) continue;
      const order = rows
        .map((_, i) => i)
        .sort((a, b) => rows[b].score - rows[a].score || rows[b].alignedMean - rows[a].alignedMean);
      const trueIdx = rows.findIndex(
        (r) => r.teeId === `T${j.trueTee}` && r.basketId === `B${j.trueBasket}`,
      );
      const rank = order.indexOf(trueIdx) + 1;
      rankByHole.set(j.hole, rank);
      n++;
      grand.n++;
      if (rank === 1) {
        r1++;
        grand.r1++;
      }
      if (rank >= 1 && rank <= 3) {
        r3++;
        grand.r3++;
      }
      if (j.rankPrimary === 1) {
        baseR1++;
        grand.baseR1++;
      }
      if (j.rankPrimary <= 3) {
        baseR3++;
        grand.baseR3++;
      }
      if (rank > 3) {
        const top = rows[order[0]];
        fails.push(
          `h${j.hole} rank${rank} (was ${j.rankPrimary}) top=${top.teeId}/${top.basketId} ` +
            `ww=${top.alignedWorstWindow.toFixed(2)} true=${rows[trueIdx]?.alignedWorstWindow.toFixed(2)}`,
        );
      }
    }
    console.log(
      `${nm}: aligned(p=${alignPow},win=${windowSrcPx}) rank1=${r1}/${n} rank<=3=${r3}/${n} ` +
        `(baseline was ${baseR1}/${baseR3})` +
        (fails.length ? `\n  ${fails.join('\n  ')}` : ''),
    );

    if (assign) {
      // One pair per badge, 1:1 on tees and baskets, maximize total score.
      // Raw scores compare across badges here; per-badge normalization was
      // tried and measured WORSE (38/61 vs 42/61 exact) — normalizing
      // inflates weak badges' false claims more than it calms strong ones.
      // Seed order = per-badge decisiveness (margin between the badge's top
      // pair and its best pair using a different tee AND basket): confident
      // badges claim endpoints first, so an ambiguous badge cannot steal a
      // confident badge's endpoint and start a cascade.
      const labels = [...rescoredByBadge.keys()];
      const chosen = new Map<string, Rescored | null>(labels.map((l) => [l, null]));
      const usedTee = new Set<string>();
      const usedBasket = new Set<string>();
      const margin = (l: string): number => {
        const rows = [...rescoredByBadge.get(l)!].sort((a, b) => b.score - a.score);
        const top = rows[0];
        if (!top) return 0;
        const rival = rows.find((r) => r.teeId !== top.teeId && r.basketId !== top.basketId);
        return top.score - (rival ? rival.score : 0);
      };
      // Total-score maximization. Diagnosed from the cached evidence: wrong
      // assignments come in THEFT CHAINS — one badge whose false top pair
      // outscores its true pair steals a neighbor's endpoint and the wrong
      // claim dominoes (Dashs h1→h2→h5→h7→h6, ending on a sprite false
      // positive). The chain is globally suboptimal (fixing Dashs h1 costs
      // 0.16 locally but returns +0.57 in total), so the fix is a better
      // optimizer, not a better heuristic: greedy seed + local search with
      // single-badge moves AND two-badge exchange moves, from several
      // deterministic start orders, keeping the highest-total solution.
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
            [...rescoredByBadge.get(l)!].sort((a, b) => b.score - a.score).slice(0, 60),
          ]),
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
          // Two-badge exchange: free both badges' endpoints, try top-K rows
          // for each jointly, keep the best feasible combination.
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
      for (const [l, r] of bestPick) {
        chosen.set(l, r);
        if (r) {
          usedTee.add(r.teeId);
          usedBasket.add(r.basketId);
        }
      }
      let ok = 0;
      let judged = 0;
      const wrong: string[] = [];
      const explain: string[] = [];
      for (const j of cache.judgments) {
        if (j.rankPrimary < 1) continue;
        judged++;
        const c = chosen.get(String(j.hole));
        if (c && c.teeId === `T${j.trueTee}` && c.basketId === `B${j.trueBasket}`) ok++;
        else {
          wrong.push(`h${j.hole}${c ? `->${c.teeId}/${c.basketId}` : '->none'}`);
          // Explain from the same evidence the assignment used: where did the
          // true pair rank for this badge, and who claimed its endpoints?
          const rows = rescoredByBadge.get(String(j.hole))!;
          const order = [...rows].sort((a, b) => b.score - a.score);
          const trueRow = rows.find(
            (r) => r.teeId === `T${j.trueTee}` && r.basketId === `B${j.trueBasket}`,
          );
          const trueRank = trueRow ? order.indexOf(trueRow) + 1 : -1;
          const claimedBy = (id: string, kind: 'tee' | 'basket'): string => {
            for (const [l, ch] of chosen) {
              if (!ch) continue;
              if ((kind === 'tee' ? ch.teeId : ch.basketId) === id) return `h${l}`;
            }
            return 'unclaimed';
          };
          const basketScore = cache.endpoints.baskets[Number((c?.basketId ?? 'B-1').slice(1))] as
            | { score?: number }
            | undefined;
          explain.push(
            `  h${j.hole}: truePair rank=${trueRank} score=${trueRow?.score.toFixed(3) ?? '-'} ` +
              `chosen=${c ? `${c.teeId}/${c.basketId} score=${c.score.toFixed(3)}` : 'none'} ` +
              `(chosen basket spriteScore=${basketScore?.score?.toFixed(2) ?? '?'}) | ` +
              `trueTee T${j.trueTee} claimed by ${claimedBy(`T${j.trueTee}`, 'tee')}, ` +
              `trueBasket B${j.trueBasket} claimed by ${claimedBy(`B${j.trueBasket}`, 'basket')}`,
          );
        }
      }
      console.log(
        `${nm}: ASSIGNED exact=${ok}/${judged}` + (wrong.length ? ` wrong: ${wrong.join(' ')}` : ''),
      );
      if (explain.length) console.log(explain.join('\n'));

      if (emit) {
        const holes = [...chosen.entries()]
          .filter(([, r]) => r)
          .map(([label, r]) => {
            const tee = cache.endpoints.tees[Number((r as Rescored).teeId.slice(1))];
            const basket = cache.endpoints.baskets[Number((r as Rescored).basketId.slice(1))] as {
              x: number;
              y: number;
              score?: number;
            };
            const j = cache.judgments.find((jj) => jj.hole === Number(label));
            const verdict =
              j && j.rankPrimary >= 1
                ? (r as Rescored).teeId === `T${j.trueTee}` &&
                  (r as Rescored).basketId === `B${j.trueBasket}`
                  ? 'correct'
                  : 'wrong'
                : 'unjudged';
            return {
              hole: Number(label),
              tee: { xPx: tee.x, yPx: tee.y + cache.viewport.top },
              basket: { xPx: basket.x, yPx: basket.y + cache.viewport.top },
              pairScore: (r as Rescored).score,
              basketSpriteScore: basket.score ?? null,
              teeId: (r as Rescored).teeId,
              basketId: (r as Rescored).basketId,
              devTruthVerdict: verdict,
            };
          })
          .sort((a, b) => a.hole - b.hole);
        writeFileSync(
          `${cacheDir}/${nm}-assignments.json`,
          JSON.stringify(
            {
              course: nm,
              coordinateFrame: 'full capture frame (viewport.top added back)',
              stack: { alignPow, windowSrcPx, zones, simple, invariants, identity, scoreMode },
              holes,
            },
            null,
            1,
          ),
        );
        console.log(`${nm}: assignments -> ${cacheDir}/${nm}-assignments.json (${holes.length} holes)`);
        assignedForOverlay = chosen;
      }
      grand.assigned += ok;
      grand.assignedN += judged;
    }

    // Verification overlay for the emitted assignment: drawn in the render
    // block below (which owns the imagery base), gated on assignedForOverlay.
    const drawAssignedOverlay = (base: Buffer): void => {
      if (!assignedForOverlay) return;
      {
        {
          // Chosen pair routes: green=correct vs dev truth, red=wrong,
          // gray=unjudged; badges red dots.
          const png2 = new PNG({ width: w, height: h });
          base.copy(png2.data);
          for (const [label, r] of assignedForOverlay) {
            if (!r) continue;
            const badge = cache.badges.find((bb) => bb.label === label);
            if (!badge) continue;
            const j = cache.judgments.find((jj) => jj.hole === Number(label));
            const verdict =
              j && j.rankPrimary >= 1
                ? r.teeId === `T${j.trueTee}` && r.basketId === `B${j.trueBasket}`
                  ? 'ok'
                  : 'bad'
                : 'na';
            const [cr, cg, cb] =
              verdict === 'ok' ? [0, 220, 0] : verdict === 'bad' ? [255, 40, 40] : [180, 180, 180];
            for (const leg of badge.legs) {
              if (leg.endpointId !== r.teeId && leg.endpointId !== r.basketId) continue;
              for (let i = 0; i < leg.path.length; i += 2) {
                const p = (leg.path[i + 1] * w + leg.path[i]) * 4;
                png2.data[p] = cr;
                png2.data[p + 1] = cg;
                png2.data[p + 2] = cb;
              }
            }
            const bx = Math.round(badge.cx / scale);
            const by = Math.round(badge.cy / scale);
            for (let dy = -2; dy <= 2; dy++) {
              for (let dx = -2; dx <= 2; dx++) {
                const xx = bx + dx;
                const yy = by + dy;
                if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
                const p = (yy * w + xx) * 4;
                png2.data[p] = 255;
                png2.data[p + 1] = 0;
                png2.data[p + 2] = 0;
              }
            }
          }
          writeFileSync(`${cacheDir}/${nm}-assigned.png`, PNG.sync.write(png2));
        }
      }
    };

    if (render) {
      const fullImage = decodeRgbaBin(`/workspace/nuthing-work/traces-py/${nm}.rgba.bin`);
      const image = cropRows(fullImage, detectMapViewport(fullImage));
      const png = new PNG({ width: w, height: h });
      for (let fy = 0; fy < h; fy++) {
        for (let fx = 0; fx < w; fx++) {
          let rr = 0;
          let gg = 0;
          let bb = 0;
          let cnt = 0;
          for (let dy = 0; dy < scale; dy++) {
            const sy = fy * scale + dy;
            if (sy >= image.height) continue;
            for (let dx = 0; dx < scale; dx++) {
              const sx = fx * scale + dx;
              if (sx >= image.width) continue;
              const p = (sy * image.width + sx) * 4;
              rr += image.data[p];
              gg += image.data[p + 1];
              bb += image.data[p + 2];
              cnt++;
            }
          }
          const o = (fy * w + fx) * 4;
          png.data[o] = cnt ? rr / cnt : 0;
          png.data[o + 1] = cnt ? gg / cnt : 0;
          png.data[o + 2] = cnt ? bb / cnt : 0;
          png.data[o + 3] = 255;
        }
      }
      const put = (fx: number, fy: number, r: number, g: number, b: number, rad = 0): void => {
        for (let dy = -rad; dy <= rad; dy++) {
          for (let dx = -rad; dx <= rad; dx++) {
            const xx = fx + dx;
            const yy = fy + dy;
            if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
            const p = (yy * w + xx) * 4;
            png.data[p] = r;
            png.data[p + 1] = g;
            png.data[p + 2] = b;
          }
        }
      };
      const pristine = Buffer.from(png.data);
      pristineBase = pristine;
      drawAssignedOverlay(pristine);
      for (const j of cache.judgments) {
        const rank = rankByHole.get(j.hole);
        if (!rank) continue;
        const badge = cache.badges.find((bb) => Number(bb.label) === j.hole);
        if (!badge) continue;
        const [r, g, b] = rank === 1 ? [0, 220, 0] : rank <= 3 ? [255, 220, 0] : [255, 60, 0];
        for (const leg of badge.legs) {
          if (leg.endpointId !== `T${j.trueTee}` && leg.endpointId !== `B${j.trueBasket}`) continue;
          for (let i = 0; i < leg.path.length; i += 2) put(leg.path[i], leg.path[i + 1], r, g, b);
        }
        put(Math.round(badge.cx / scale), Math.round(badge.cy / scale), 255, 0, 0, 2);
      }
      writeFileSync(`${cacheDir}/${nm}-replay-aligned.png`, PNG.sync.write(png));
      // Per-failure overlays: true pair (green) vs current top competitor (red).
      for (const j of cache.judgments) {
        const rank = rankByHole.get(j.hole);
        if (!rank || rank <= 3) continue;
        const badge = cache.badges.find((bb) => Number(bb.label) === j.hole);
        const rows = rescoredByBadge.get(String(j.hole));
        if (!badge || !rows) continue;
        const top = [...rows].sort((a, b) => b.score - a.score)[0];
        const fail = new PNG({ width: w, height: h });
        pristine.copy(fail.data);
        const draw = (teeId: string, basketId: string, r: number, g: number, b: number): void => {
          for (const leg of badge.legs) {
            if (leg.endpointId !== teeId && leg.endpointId !== basketId) continue;
            for (let i = 0; i < leg.path.length; i += 2) {
              const p = (leg.path[i + 1] * w + leg.path[i]) * 4;
              fail.data[p] = r;
              fail.data[p + 1] = g;
              fail.data[p + 2] = b;
            }
          }
        };
        draw(top.teeId, top.basketId, 255, 40, 40);
        draw(`T${j.trueTee}`, `B${j.trueBasket}`, 0, 220, 0);
        writeFileSync(`${cacheDir}/${nm}-h${j.hole}-replay-fail.png`, PNG.sync.write(fail));
      }
    }
  }
  console.log(
    `TOTAL aligned rank1=${grand.r1}/${grand.n} rank<=3=${grand.r3}/${grand.n} ` +
      `(baseline worstWindow ${grand.baseR1}/${grand.baseR3})` +
      (grand.assignedN ? ` ASSIGNED exact=${grand.assigned}/${grand.assignedN}` : ''),
  );
}

main();
