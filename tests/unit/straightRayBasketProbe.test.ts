// Observational spike: for Lenard's known zero-bend holes, ask whether the
// existing tee->badge ownership alone identifies the basket by extending that
// direction forward. Truth is evaluator-only: it identifies which detected
// basket is the correct one after all ray candidates have been scored.

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
const TRUE_BASKET_TOLERANCE_PX = 26;

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
  test('rank every basket from the known tee->badge direction', async () => {
    const raster = loadCourseRaster(lenard);
    const truth = loadCourseTruth(lenard).holes;
    const paramsHash = await sha256Hex(canonicalJson(resolved));
    const run = runThreeFactor(raster, { config: resolved, paramsHash });

    const badgesById = new Map(run.measurement.badges.map((b) => [b.detId, b]));
    const teesById = new Map(run.assignment.tees.map((t) => [t.detId, t]));
    const assignmentsByBadge = new Map(run.assignment.assignments.map((a) => [a.badgeId, a]));

    const rows = [] as Record<string, string | number | boolean>[];
    let angleRank1 = 0;
    let rayMissRank1 = 0;
    let forwardTrue = 0;
    let teeBadgeTruthMatched = 0;

    for (const hole of [...truth].sort((a, b) => a.number - b.number)) {
      const badge = run.measurement.badges.find((b) => b.label !== null && Number(b.label) === hole.number);
      if (!badge) throw new Error(`H${hole.number}: badge missing`);
      const assignment = assignmentsByBadge.get(badge.detId);
      if (!assignment) throw new Error(`H${hole.number}: assignment missing for ${badge.detId}`);
      const tee = teesById.get(assignment.teeId);
      if (!tee) throw new Error(`H${hole.number}: tee ${assignment.teeId} missing`);

      const teeTruthDistancePx = dist(hole.tee, { xPx: tee.xPx, yPx: tee.yPx });
      if (teeTruthDistancePx <= TRUE_BASKET_TOLERANCE_PX) teeBadgeTruthMatched++;

      const scored = run.measurement.baskets.map((basket) => ({
        basket,
        ...rayGeometry(
          { xPx: tee.xPx, yPx: tee.yPx },
          { xPx: badge.cxPx, yPx: badge.cyPx },
          { xPx: basket.tipXPx, yPx: basket.tipYPx }
        ),
        truthDistancePx: dist(hole.basket, { xPx: basket.tipXPx, yPx: basket.tipYPx })
      }));

      const trueCandidate = [...scored].sort((a, b) => a.truthDistancePx - b.truthDistancePx)[0];
      if (!trueCandidate || trueCandidate.truthDistancePx > TRUE_BASKET_TOLERANCE_PX) {
        throw new Error(`H${hole.number}: no detected basket within ${TRUE_BASKET_TOLERANCE_PX}px of truth`);
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

      const angleRunner = byAngle.find((x) => x.basket.detId !== trueCandidate.basket.detId)!;
      const missRunner = byMiss.find((x) => x.basket.detId !== trueCandidate.basket.detId)!;

      rows.push({
        hole: hole.number,
        teeId: tee.detId,
        badgeId: badge.detId,
        trueBasketId: trueCandidate.basket.detId,
        currentBasketId: assignment.basketId,
        teeTruthDistancePx: Number(teeTruthDistancePx.toFixed(2)),
        trueBasketTruthDistancePx: Number(trueCandidate.truthDistancePx.toFixed(2)),
        forward: trueCandidate.alongPx > 0,
        alongPx: Number(trueCandidate.alongPx.toFixed(2)),
        perpendicularPx: Number(trueCandidate.perpendicularPx.toFixed(2)),
        angleErrorDeg: Number(trueCandidate.angleErrorDeg.toFixed(3)),
        angleRank,
        angleRunnerBasketId: angleRunner.basket.detId,
        angleRunnerErrorDeg: Number(angleRunner.angleErrorDeg.toFixed(3)),
        angleMarginDeg: Number((angleRunner.angleErrorDeg - trueCandidate.angleErrorDeg).toFixed(3)),
        rayMissPx: Number(trueCandidate.rayMissPx.toFixed(2)),
        rayMissRank,
        missRunnerBasketId: missRunner.basket.detId,
        missRunnerPx: Number(missRunner.rayMissPx.toFixed(2)),
        rayMissMarginPx: Number((missRunner.rayMissPx - trueCandidate.rayMissPx).toFixed(2))
      });
    }

    console.table(rows);
    console.log(`LENARD_STRAIGHT_RAY_HOLES=${truth.length}`);
    console.log(`LENARD_TEE_BADGE_TRUTH_MATCHED=${teeBadgeTruthMatched}`);
    console.log(`LENARD_TRUE_BASKET_FORWARD=${forwardTrue}`);
    console.log(`LENARD_ANGLE_RANK1=${angleRank1}`);
    console.log(`LENARD_RAYMISS_RANK1=${rayMissRank1}`);

    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(resolve(OUT_DIR, 'Lenard.straight-ray-basket.json'), JSON.stringify({
      source: {
        course: lenard.name,
        imageId: raster.imageId,
        configName: resolved.name,
        paramsHash,
        note: 'Truth is evaluator-only; candidate geometry uses current detected tee/badge/basket coordinates only.'
      },
      summary: {
        holes: truth.length,
        teeBadgeTruthMatched,
        trueBasketForward: forwardTrue,
        angleRank1,
        rayMissRank1
      },
      rows
    }, null, 2));

    // These are baseline sanity checks, not acceptance thresholds for the shortcut.
    expect(truth).toHaveLength(18);
    expect(run.measurement.baskets).toHaveLength(18);
    expect(teeBadgeTruthMatched).toBe(18);
  }, 120000);
});
