// Observational spike: for Lenard's known zero-bend holes, ask whether the
// accepted tee->badge lock alone identifies the basket by extending that
// direction forward. Truth is evaluator-only: it labels the correct detected
// basket after every blind geometry candidate has been scored.

import { describe, expect, test } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_EXECUTION,
  canonicalJson,
  parseConfig,
  resolveConfig,
  runThreeFactor,
  sha256Hex
} from '@chainspot/alg/detectors/threeFactor';
import defaultConfigJson from '@chainspot/alg/detectors/threeFactor/configs/default.json';
import { COURSES, loadCourseRaster, loadCourseTruth } from './helpers/courseFixture';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '../../artifacts/sweep/straight-ray-basket-probe');
const TRUE_ENDPOINT_TOLERANCE_PX = 26;

interface Point { readonly xPx: number; readonly yPx: number }

function dist(a: Point, b: Point): number {
  return Math.hypot(a.xPx - b.xPx, a.yPx - b.yPx);
}

function rayGeometry(tee: Point, badge: Point, basket: Point) {
  const dx = badge.xPx - tee.xPx;
  const dy = badge.yPx - tee.yPx;
  const len = Math.hypot(dx, dy);
  if (!(len > 0)) throw new Error('zero-length tee->badge ray');
  const ux = dx / len;
  const uy = dy / len;
  const vx = basket.xPx - badge.xPx;
  const vy = basket.yPx - badge.yPx;
  const radial = Math.hypot(vx, vy);
  const alongPx = vx * ux + vy * uy;
  const signedCrossPx = ux * vy - uy * vx;
  const perpendicularPx = Math.abs(signedCrossPx);
  const rayMissPx = alongPx >= 0 ? perpendicularPx : radial;
  const angleErrorDeg = radial > 0
    ? Math.abs(Math.atan2(signedCrossPx, alongPx)) * 180 / Math.PI
    : 0;
  return { alongPx, perpendicularPx, rayMissPx, angleErrorDeg, radialPx: radial };
}

const resolved = resolveConfig(parseConfig(defaultConfigJson), DEFAULT_EXECUTION);
const lenard = COURSES.find((course) => course.name === 'Lenard');
if (!lenard) throw new Error('Lenard fixture missing');

describe('straight ray basket probe (Lenard; observational)', () => {
  test('first forward basket inside the existing tee-badge corridor is correct 18/18', async () => {
    const raster = loadCourseRaster(lenard);
    const truth = loadCourseTruth(lenard).holes;
    const paramsHash = await sha256Hex(canonicalJson(resolved));
    const run = runThreeFactor(raster, { config: resolved, paramsHash });

    const corridorWidthPx = run.measurement.parameters.corridorWidthPx;
    if (!(typeof corridorWidthPx === 'number' && Number.isFinite(corridorWidthPx))) {
      throw new Error('measurement.parameters.corridorWidthPx missing');
    }
    // Use half-width because corridorWidthPx is the already-published physical
    // corridor width. This is not a fitted Lenard threshold.
    const corridorHalfWidthPx = corridorWidthPx / 2;

    const lockUnit = run.trace?.units.find((unit) => unit.id === 'teeBadgeLock');
    const locks = (lockUnit?.drawables ?? []).filter((drawable) =>
      drawable.type === 'polyline' &&
      drawable.verdict === 'accepted' &&
      drawable.visualRole === 'tee-badge-path' &&
      Array.isArray(drawable.path) &&
      typeof drawable.values?.hole === 'number'
    );

    const rows = [] as Record<string, string | number | boolean>[];
    let angleRank1 = 0;
    let rayMissRank1 = 0;
    let corridorFirstRank1 = 0;
    let forwardTrue = 0;
    let teeBadgeTruthMatched = 0;

    for (const hole of [...truth].sort((a, b) => a.number - b.number)) {
      const lock = locks.find((drawable) => drawable.values?.hole === hole.number);
      if (!lock || lock.type !== 'polyline' || !Array.isArray(lock.path) || lock.path.length < 2) {
        throw new Error(`H${hole.number}: accepted teeBadgeLock path missing`);
      }
      const first = lock.path[0];
      const last = lock.path[lock.path.length - 1];
      const tee = { xPx: first[0], yPx: first[1] };
      const badge = { xPx: last[0], yPx: last[1] };

      const teeTruthDistancePx = dist(hole.tee, tee);
      if (teeTruthDistancePx <= TRUE_ENDPOINT_TOLERANCE_PX) teeBadgeTruthMatched++;

      const scored = run.measurement.baskets.map((basket) => ({
        basket,
        ...rayGeometry(
          tee,
          badge,
          { xPx: basket.tipXPx, yPx: basket.tipYPx }
        ),
        truthDistancePx: dist(hole.basket, { xPx: basket.tipXPx, yPx: basket.tipYPx })
      }));

      const trueCandidate = [...scored].sort((a, b) => a.truthDistancePx - b.truthDistancePx)[0];
      if (!trueCandidate || trueCandidate.truthDistancePx > TRUE_ENDPOINT_TOLERANCE_PX) {
        throw new Error(`H${hole.number}: no detected basket within ${TRUE_ENDPOINT_TOLERANCE_PX}px of truth`);
      }

      const byAngle = [...scored].sort((a, b) =>
        Number(a.alongPx < 0) - Number(b.alongPx < 0) ||
        a.angleErrorDeg - b.angleErrorDeg ||
        a.rayMissPx - b.rayMissPx
      );
      const byMiss = [...scored].sort((a, b) => a.rayMissPx - b.rayMissPx || a.angleErrorDeg - b.angleErrorDeg);
      const angleRank = byAngle.findIndex((x) => x.basket.detId === trueCandidate.basket.detId) + 1;
      const rayMissRank = byMiss.findIndex((x) => x.basket.detId === trueCandidate.basket.detId) + 1;
      if (angleRank === 1) angleRank1++;
      if (rayMissRank === 1) rayMissRank1++;
      if (trueCandidate.alongPx > 0) forwardTrue++;

      const corridorCandidates = scored
        .filter((x) => x.alongPx > 0 && x.perpendicularPx <= corridorHalfWidthPx)
        .sort((a, b) => a.alongPx - b.alongPx || a.perpendicularPx - b.perpendicularPx);
      const corridorFirstRank = corridorCandidates.findIndex(
        (x) => x.basket.detId === trueCandidate.basket.detId
      ) + 1;
      if (corridorFirstRank === 1) corridorFirstRank1++;
      const corridorRunner = corridorCandidates[1];

      rows.push({
        hole: hole.number,
        lockRef: lock.ref ?? 'UNKNOWN',
        trueBasketId: trueCandidate.basket.detId,
        teeTruthDistancePx: Number(teeTruthDistancePx.toFixed(2)),
        trueBasketTruthDistancePx: Number(trueCandidate.truthDistancePx.toFixed(2)),
        forward: trueCandidate.alongPx > 0,
        alongPx: Number(trueCandidate.alongPx.toFixed(2)),
        perpendicularPx: Number(trueCandidate.perpendicularPx.toFixed(2)),
        angleErrorDeg: Number(trueCandidate.angleErrorDeg.toFixed(3)),
        angleRank,
        rayMissRank,
        corridorCandidates: corridorCandidates.length,
        corridorFirstRank,
        nextAlongMarginPx: corridorRunner
          ? Number((corridorRunner.alongPx - corridorCandidates[0].alongPx).toFixed(2))
          : -1
      });
    }

    console.table(rows);
    console.log(`LENARD_STRAIGHT_RAY_HOLES=${truth.length}`);
    console.log(`LENARD_TEE_BADGE_LOCKS=${locks.length}`);
    console.log(`LENARD_TEE_BADGE_TRUTH_MATCHED=${teeBadgeTruthMatched}`);
    console.log(`LENARD_TRUE_BASKET_FORWARD=${forwardTrue}`);
    console.log(`LENARD_ANGLE_RANK1=${angleRank1}`);
    console.log(`LENARD_RAYMISS_RANK1=${rayMissRank1}`);
    console.log(`LENARD_CORRIDOR_WIDTH_PX=${corridorWidthPx}`);
    console.log(`LENARD_CORRIDOR_HALF_WIDTH_PX=${corridorHalfWidthPx}`);
    console.log(`LENARD_CORRIDOR_FIRST_RANK1=${corridorFirstRank1}`);

    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(resolve(OUT_DIR, 'Lenard.straight-ray-basket.json'), JSON.stringify({
      source: {
        course: lenard.name,
        imageId: raster.imageId,
        configName: resolved.name,
        paramsHash,
        input: 'accepted teeBadgeLock polyline testimony + detected basket tips',
        truthUse: 'evaluator only; labels the correct detected endpoint after blind scoring'
      },
      rule: {
        description: 'first forward detected basket inside half of the already-published corridor width',
        corridorWidthPx,
        corridorHalfWidthPx
      },
      summary: {
        holes: truth.length,
        teeBadgeLocks: locks.length,
        teeBadgeTruthMatched,
        trueBasketForward: forwardTrue,
        angleRank1,
        rayMissRank1,
        corridorFirstRank1
      },
      rows
    }, null, 2));

    expect(truth).toHaveLength(18);
    expect(run.measurement.baskets).toHaveLength(18);
    expect(locks).toHaveLength(18);
    expect(teeBadgeTruthMatched).toBe(18);
    expect(corridorFirstRank1).toBe(18);
  }, 120000);
});
