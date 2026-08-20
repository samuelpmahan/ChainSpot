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
import { COURSE_CORRIDOR_WIDTH, DEFAULT_CORRIDOR_WIDTH } from '../../src/lib/nuthing/badgeOcclusion';
import { rescoreCourse, assignPairs } from '../../src/lib/nuthing/pairScoring';
import type { Rescored, ScoringCourse } from '../../src/lib/nuthing/pairScoring';

interface CacheJudgment {
  hole: number;
  trueTee: number;
  trueBasket: number;
  rankPrimary: number;
}
type CacheCourse = ScoringCourse & {
  course: string;
  viewport: { top: number; bottom: number };
  judgments: CacheJudgment[];
};

const COURSES = process.env.REPLAY_COURSES
  ? process.env.REPLAY_COURSES.split(',')
  : ['DashsTrack-full', 'HeritagePark-full', 'Lenard-full', 'TowneLake-full'];

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
  // Replay layer 7 — Z-fit rescue: model-based <=2-bend polyline scoring
  // for pairs whose Dijkstra route detoured off the true corridor.
  const zfitIdx = args.indexOf('--zfit');
  const zfit = zfitIdx >= 0 ? (args.splice(zfitIdx, 1), true) : false;
  const ZFIT_FACTOR = Number(process.env.ZFIT_FACTOR ?? '0.9');
  const ZFIT_F1 = Number(process.env.ZFIT_F1 ?? '0.9');
  const ZFIT_F2 = Number(process.env.ZFIT_F2 ?? '0.8');
  const ZFIT_TOPK = Number(process.env.ZFIT_TOPK ?? '80');
  const ZFIT_RESCUE_MAX = Number(process.env.ZFIT_RESCUE_MAX ?? '0.28');
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
  // Replay layer 8 — agreement-bearing bonus (--abearing): where the two
  // independent approach instruments (backwalk, zone-stamp) agree within
  // 20 deg (measured 84% precision at that gate), pairs whose basket
  // receives its corridor FROM the badge direction get a bonus. Bonus-only:
  // dogleg true pairs whose approach differs from the badge direction lose
  // nothing. Built for the same-tee-wrong-basket rivalry, where the rival
  // basket's own corridor arrives from a different hole's direction.
  const abIdx = args.indexOf('--abearing');
  const abearing = abIdx >= 0 ? (args.splice(abIdx, 1), true) : false;
  const AB_W = Number(process.env.AB_W ?? '0.5');
  const AB_SIGMA = Number(process.env.AB_SIGMA ?? '15');
  const ZONE_DIR = process.env.ZONE_DIR ??
    '/tmp/claude-0/-home-user-ChainSpot/f2944dcd-e5cd-51df-ba70-0228cccdd281/scratchpad';
  const identIdx = args.indexOf('--identity');
  const identity = identIdx >= 0 ? (args.splice(identIdx, 1), true) : false;
  const IDENT_FLOOR = grab('--ident-floor', 0.4);
  // --emit: write the consumable product — per-course hole→(tee, basket)
  // assignments in FULL-FRAME pixel coordinates + a verification overlay.
  const emitIdx = args.indexOf('--emit');
  const emit = emitIdx >= 0 ? (args.splice(emitIdx, 1), true) : false;
  const ALIGN_SIGMA_DEG = 12;
  // Band recentered to the MEASURED badge-position range (0.17-0.54, n=72;
  // the old 0.45 +- 0.15 punished low-frac holes asymmetrically - Heritage
  // h7's badge sits at 0.165 of the chord and its true pair took a 0.44x
  // penalty, drowning it below a straight-line rival).
  const FRAC_CENTER = Number(process.env.FRAC_CENTER ?? '0.36');
  const FRAC_HALF_WIDTH = Number(process.env.FRAC_HALF_WIDTH ?? '0.19');
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
    const CORRIDOR_W = COURSE_CORRIDOR_WIDTH[nm] ?? DEFAULT_CORRIDOR_WIDTH;
    const agreedBearing = new Map<string, number>();
    if (abearing) {
      try {
        const bwj = JSON.parse(readFileSync(`${cacheDir}/${nm}-backwalk.json`, 'utf8')) as {
          baskets: { id: string; approachBearingDeg: number | null }[];
        };
        const zj = JSON.parse(readFileSync(`${ZONE_DIR}/${nm}-zone-bearings-v4.json`, 'utf8')) as {
          id: string; est: number;
        }[];
        const zmap = new Map(zj.map((r) => [r.id, r.est]));
        for (const b of bwj.baskets) {
          const z = zmap.get(b.id);
          if (z === undefined || b.approachBearingDeg === null) continue;
          let d = Math.abs(z - b.approachBearingDeg) % 360;
          if (d > 180) d = 360 - d;
          if (d > 20) continue;
          const va = Math.cos((z * Math.PI) / 180) + Math.cos((b.approachBearingDeg * Math.PI) / 180);
          const vb = Math.sin((z * Math.PI) / 180) + Math.sin((b.approachBearingDeg * Math.PI) / 180);
          agreedBearing.set(b.id, (Math.atan2(vb, va) * 180) / Math.PI);
        }
      } catch {
        // sidecars absent: layer inert
      }
    }
    const support = new Float32Array(readFileSync(`${cacheDir}/${nm}-field.bin`).buffer.slice(0));
    const theta = new Float32Array(readFileSync(`${cacheDir}/${nm}-theta.bin`).buffer.slice(0));
    const rescoredByBadge = rescoreCourse(cache, support, theta, {
      alignPow,
      windowSrcPx,
      scoreMode,
      zones,
      simple,
      invariants,
      identity,
      identFloor: IDENT_FLOOR,
      recoveredTeePrior: Number(process.env.RECOVERED_TEE_PRIOR ?? '0.7'),
      fracCenter: FRAC_CENTER,
      fracHalfWidth: FRAC_HALF_WIDTH,
      collinBonus: Number(process.env.COLLIN_BONUS ?? '0.6'),
      collinSigma: Number(process.env.COLLIN_SIGMA ?? '2'),
      zfit,
      corridorWidthPx: CORRIDOR_W,
      zfitFactor: ZFIT_FACTOR,
      zfitF1: ZFIT_F1,
      zfitF2: ZFIT_F2,
      zfitTopK: ZFIT_TOPK,
      zfitRescueMax: ZFIT_RESCUE_MAX,
      ...(abearing ? { agreedBearing, abW: AB_W, abSigma: AB_SIGMA } : {}),
    });

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
      if (process.env.DEBUG_RANKS === '1' && rank > 1) {
        const top = rows[order[0]];
        const tr = rows[trueIdx];
        console.log(
          `  RANKDBG h${j.hole} rank${rank} true ${tr.teeId}/${tr.basketId} score=${tr.score.toFixed(4)} ` +
            `vs top ${top.teeId}/${top.basketId} score=${top.score.toFixed(4)} ratio=${(tr.score / top.score).toFixed(3)}`,
        );
      }
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
      const bestPick = assignPairs(rescoredByBadge);
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
