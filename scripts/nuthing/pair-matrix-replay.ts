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
    tees: { id: string; x: number; y: number; onRing: boolean }[];
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
      const labels = [...rescoredByBadge.keys()];
      const chosen = new Map<string, Rescored | null>(labels.map((l) => [l, null]));
      const usedTee = new Set<string>();
      const usedBasket = new Set<string>();
      // Greedy seed over all (badge, pair) by score.
      const all: { label: string; row: Rescored }[] = [];
      for (const l of labels) for (const row of rescoredByBadge.get(l)!) all.push({ label: l, row });
      all.sort((a, b) => b.row.score - a.row.score);
      for (const { label, row } of all) {
        if (chosen.get(label) || usedTee.has(row.teeId) || usedBasket.has(row.basketId)) continue;
        chosen.set(label, row);
        usedTee.add(row.teeId);
        usedBasket.add(row.basketId);
      }
      // 2-swap local search: try replacing any one badge's pair (freeing its
      // endpoints) with its best feasible alternative; accept improvements.
      let improved = true;
      let guard = 0;
      while (improved && guard++ < 50) {
        improved = false;
        for (const l of labels) {
          const cur = chosen.get(l);
          if (cur) {
            usedTee.delete(cur.teeId);
            usedBasket.delete(cur.basketId);
          }
          let best: Rescored | null = null;
          for (const row of rescoredByBadge.get(l)!) {
            if (usedTee.has(row.teeId) || usedBasket.has(row.basketId)) continue;
            if (!best || row.score > best.score) best = row;
          }
          if (best && (!cur || best.score > cur.score + 1e-12)) {
            chosen.set(l, best);
            improved = improved || !cur || best !== cur;
          } else if (cur) {
            chosen.set(l, cur);
          }
          const now = chosen.get(l);
          if (now) {
            usedTee.add(now.teeId);
            usedBasket.add(now.basketId);
          }
        }
      }
      let ok = 0;
      let judged = 0;
      const wrong: string[] = [];
      for (const j of cache.judgments) {
        if (j.rankPrimary < 1) continue;
        judged++;
        const c = chosen.get(String(j.hole));
        if (c && c.teeId === `T${j.trueTee}` && c.basketId === `B${j.trueBasket}`) ok++;
        else wrong.push(`h${j.hole}${c ? `->${c.teeId}/${c.basketId}` : '->none'}`);
      }
      console.log(
        `${nm}: ASSIGNED exact=${ok}/${judged}` + (wrong.length ? ` wrong: ${wrong.join(' ')}` : ''),
      );
      grand.assigned += ok;
      grand.assignedN += judged;
    }

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
