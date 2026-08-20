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
import { predictProbs } from '../../src/lib/nuthing/digits/logistic';
import type { LogisticModel } from '../../src/lib/nuthing/digits/logistic';
import { prepareSpriteTemplate } from '../../src/lib/nuthing/endpoints';
import type { SpriteTemplate } from '../../src/lib/nuthing/endpoints';
import {
  COURSE_CORRIDOR_WIDTH,
  DEFAULT_CORRIDOR_WIDTH,
} from '../../src/lib/nuthing/badgeOcclusion';
import { detectMapViewport, cropRows } from '../../src/lib/nuthing/viewport';
import { decodeRgbaBin } from './decode';
import {
  measureCoursePairs,
  FIELD_ORIENTATIONS,
  FIELD_WIDTHS_SRC,
  WORST_WINDOW_SRC_PX,
  WAIVER_RADIUS_FIELD,
  WAIVER_MAX_COST,
  SUPPORT_TAU,
} from '../../src/lib/nuthing/coursePairing';
import type { BadgeMatrix, PairEvidence } from '../../src/lib/nuthing/coursePairing';

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

function main(): void {
  const args = process.argv.slice(2);
  const courseIdx = args.indexOf('--course');
  const onlyCourse = courseIdx >= 0 ? args.splice(courseIdx, 2)[1] : null;
  // Measurement variant: occlusion-aware badge patching (halo cap +
  // one-sided edge evidence with the per-course corridor width). Changes
  // the measured field, so it belongs in the measurement step and should
  // be written to its own cache directory.
  const patchIdx = args.indexOf('--patch-badges');
  const patchBadges = patchIdx >= 0 ? (args.splice(patchIdx, 1), true) : false;
  // Demo-course mode (no truth): adds NAME to the course table with an empty
  // truth list, so the cache/emit side runs while all judgment sections
  // degrade to no-ops. Raster still comes from traces-py/<NAME>.rgba.bin.
  const demoIdx = args.indexOf('--demo-course');
  const demoCourse = demoIdx >= 0 ? args.splice(demoIdx, 2)[1] : null;
  // Dual-scale capture support: badges and basket sprites are screen-space
  // furniture (fixed 42x66 sprite, fixed badge frame) while corridors, zones
  // and tee pads are geographic. A capture at a different map zoom is handled
  // by running the badge/sprite stages on the NATIVE raster and everything
  // geometric on the course raster (native downscaled by --geo-scale), with
  // the screen-space detections mapped into the geometry frame.
  const nativeIdx = args.indexOf('--native-raster');
  const nativeRasterPath = nativeIdx >= 0 ? args.splice(nativeIdx, 2)[1] : null;
  const scaleIdx = args.indexOf('--geo-scale');
  const geoScale = scaleIdx >= 0 ? Number(args.splice(scaleIdx, 2)[1]) : 0.5;
  const [outDir] = args;
  if (!outDir) {
    console.error('Usage: tsx scripts/nuthing/pair-matrix.ts OUT_DIR [--course NAME]');
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });
  const spriteTemplate = prepareSpriteTemplate(
    JSON.parse(
      readFileSync('resources/nuthing-p2/endpoints/basket-sprite.json', 'utf8'),
    ) as SpriteTemplate,
  );
  const model = JSON.parse(
    readFileSync('resources/nuthing-p2/digits/models/logistic.json', 'utf8'),
  ) as LogisticModel;
  const truthAll = loadTruth();
  if (demoCourse) truthAll[demoCourse] = [];

  const grand = { holes: 0, rank1: 0, rank3: 0 };
  for (const nm of Object.keys(truthAll)) {
    if (onlyCourse && nm !== onlyCourse) continue;
    const t0 = performance.now();
    const fullImage = decodeRgbaBin(`/workspace/nuthing-work/traces-py/${nm}.rgba.bin`);
    const viewport = detectMapViewport(fullImage);
    const image = cropRows(fullImage, viewport);
    let nativeInput: { image: ReturnType<typeof cropRows>; viewportTop: number } | undefined;
    if (nativeRasterPath) {
      const nativeFull = decodeRgbaBin(nativeRasterPath);
      const nativeVp = detectMapViewport(nativeFull);
      nativeInput = { image: cropRows(nativeFull, nativeVp), viewportTop: nativeVp.top };
    }
    let recoveredForCourse: { xPx: number; yPx: number; score: number }[] = [];
    try {
      const recovered = JSON.parse(
        readFileSync('resources/nuthing-p2/endpoints/recovered-tees.json', 'utf8'),
      ) as Record<string, { xPx: number; yPx: number; score: number }[]>;
      recoveredForCourse = recovered[nm] ?? [];
    } catch {
      // resource absent: run without recoveries
    }
    const W = COURSE_CORRIDOR_WIDTH[nm] ?? DEFAULT_CORRIDOR_WIDTH;
    const measured = measureCoursePairs({
      courseName: nm,
      image,
      viewportTop: viewport.top,
      ...(nativeInput ? { native: nativeInput, geoScale } : {}),
      corridorWidthPx: W,
      patchBadges,
      spriteTemplate,
      digitScorer: { name: 'logistic', scores: (m) => predictProbs(model, m) },
      recoveredTees: recoveredForCourse,
      onLog: (message) => console.log(message),
    });
    const { field, readings, teePoints, basketPoints, matrices } = measured;
    const fieldMs = performance.now() - t0;
    console.log(
      `${nm}: viewport[${viewport.top},${viewport.bottom}) field ${field.width}x${field.height} ` +
        `(${fieldMs.toFixed(0)}ms) tees=${teePoints.length} ` +
        `(${teePoints.filter((t) => t.tier === 'ring').length} ring / ` +
        `${teePoints.filter((t) => t.tier === 'component').length} comp, ` +
        `${teePoints.filter((t) => t.onRing).length} on a C2D ring) ` +
        `baskets=${basketPoints.length} badges=${readings.filter((r) => r.label).length} labeled`,
    );


    // --- Truth matching + ranks ---------------------------------------------
    const truth = truthAll[nm];
    // Truth matching: tee within 18px of a candidate center (registered truth
    // carries ~4px residuals; one edge tee renders 14px off its annotation);
    // basket within 16px of a matched sprite's pole tip.
    const matchTee = (p: [number, number]): number => {
      let best = -1;
      let bestD = 18;
      teePoints.forEach((tp, i) => {
        const d = Math.hypot(tp.x - p[0], tp.y - p[1]);
        if (d <= bestD) {
          bestD = d;
          best = i;
        }
      });
      return best;
    };
    const matchBasket = (p: [number, number]): number => {
      let best = -1;
      let bestD = 16;
      basketPoints.forEach((bp, i) => {
        const d = Math.hypot(bp.x - p[0], bp.y - p[1]);
        if (d <= bestD) {
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
              id: `T${i}`, x: p.x, y: p.y, tier: p.tier, angle: p.angle, onRing: p.onRing,
            })),
            baskets: basketPoints.map((p, i) => ({
              id: `B${i}`, x: p.x, y: p.y, spriteCx: p.cx, spriteCy: p.cy, score: p.score,
            })),
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
