import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { createExecBoard, executeCompiledPlan } from '@chainspot/alg/exec';
import { createNodeSink } from '@chainspot/alg/exec/node-sink';
import { createTraceContext, resolveConfiguredParams } from '@chainspot/alg/detectors/threeFactor/engine';
import { seedBoard } from '@chainspot/alg/detectors/threeFactor/measure';
import type { EvidenceBoard } from '@chainspot/alg/detectors/threeFactor/features/types';
import type { BadgeEvidence, BasketEvidence, TeeEvidence, ThreeFactorAssignment, ThreeFactorMeasurement } from '@chainspot/alg/detectors/threeFactor/types';
import type { SpriteMatch } from '@chainspot/alg/detectors/threeFactor/endpoints';
import { buildTeeRecoveryCandidates, type TeeRecoveryCandidate } from '@chainspot/alg/detectors/threeFactor/features/g3.teeRecovery';
import { synthesizePhantomTees } from '@chainspot/alg/detectors/threeFactor/features/g3.phantomTee';
import { loadConfig } from '../../scripts/chainspot-lab/sweep/configIo';
import { canonicalizeInputs } from '../../scripts/chainspot-lab/sweep/inputShim';

const ROOT = resolve(import.meta.dirname, '../..');
const CONFIG = resolve(ROOT, 'packages/alg/src/detectors/threeFactor/configs/default.json');
const CORPUS = resolve(process.env.CHAINSPOT_CORPUS_ROOT ?? resolve(ROOT, '..', 'chainspot-corpus'));
const RASTER_TOLERANCE_PX = 1.25;
const OBSERVABLE_TO_NULL_PRIOR_ODDS = 17; // deliberately broad: one NULL slot per 18-hole card
const TOP_K_PER_TARGET_FOR_JOINT = 12;

interface LockLike {
  readonly badgeId: string;
  readonly teeId: string;
  readonly tier: 'visible' | 'recovered';
  readonly hole?: number;
  readonly score: number;
  readonly chordPx: number;
  readonly axisErrorDeg: number | 'UNKNOWN';
}
interface AbstentionLike {
  readonly badgeId: string;
  readonly hole?: number;
}
interface TeeBadgeEvidenceLike {
  readonly locks: readonly LockLike[];
  readonly abstentions: readonly AbstentionLike[];
}

interface RobustModel {
  readonly median: number;
  readonly scale: number;
  readonly provenance: string;
}

interface PosteriorCandidate {
  readonly kind: 'candidate';
  readonly id: string;
  readonly badgeId: string;
  readonly hole: string | null;
  readonly componentLabels: readonly number[];
  readonly centerXPx: number;
  readonly centerYPx: number;
  readonly supportPixels: number;
  readonly unexplainedPixels: number;
  readonly distancePx: number;
  readonly axisErrorDeg: number | null;
  readonly logTerms: {
    readonly support: number;
    readonly distance: number;
    readonly axis: number;
    readonly contradictions: number;
    readonly multiplicityAndPrior: number;
  };
  readonly logWeightVsNull: number;
  posterior?: number;
}
interface NullCandidate {
  readonly kind: 'null';
  readonly id: 'NULL';
  readonly badgeId: string;
  readonly hole: string | null;
  readonly componentLabels: readonly [];
  readonly logWeightVsNull: 0;
  posterior?: number;
}
type Hypothesis = PosteriorCandidate | NullCandidate;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return Number.NaN;
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

function robustModel(values: readonly number[], floor: number, provenance: string): RobustModel {
  const center = median(values);
  const mad = median(values.map((value) => Math.abs(value - center)));
  return {
    median: center,
    scale: Math.max(floor, 1.4826 * mad),
    provenance
  };
}

function axisErrorDeg(candidate: TeeRecoveryCandidate): number | null {
  const a = candidate.badgeAxisAngleRad;
  const b = candidate.teeToBadgeAngleRad;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const d = Math.atan2(Math.sin((a as number) - (b as number)), Math.cos((a as number) - (b as number)));
  return Math.abs(d) * 180 / Math.PI;
}

function explains(candidate: TeeRecoveryCandidate, point: readonly [number, number]): boolean {
  const fit = candidate.fit;
  const dx = point[0] - fit.centerXPx;
  const dy = point[1] - fit.centerYPx;
  const c = Math.cos(fit.angleRad);
  const s = Math.sin(fit.angleRad);
  const u = dx * c + dy * s;
  const v = -dx * s + dy * c;
  const hw = fit.halfWidthPx + RASTER_TOLERANCE_PX;
  const hh = fit.halfHeightPx + RASTER_TOLERANCE_PX;
  if (Math.abs(u) > hw || Math.abs(v) > hh) return false;
  const thickness = Math.max(0, fit.supportThicknessPx ?? Math.min(fit.halfWidthPx, fit.halfHeightPx));
  return Math.abs(u) >= fit.halfWidthPx - thickness - RASTER_TOLERANCE_PX ||
    Math.abs(v) >= fit.halfHeightPx - thickness - RASTER_TOLERANCE_PX;
}

function componentLabels(candidate: TeeRecoveryCandidate): number[] {
  const labels = new Set<number>();
  for (const id of candidate.supportingComponentIds) {
    for (const match of id.matchAll(/\d+/g)) labels.add(Number(match[0]));
  }
  return [...labels].sort((a, b) => a - b);
}

function studentTLikeLogLikelihood(z: number): number {
  // Heavy-tailed on purpose: distance surprises lose probability smoothly;
  // they do not cross a cliff and become impossible.
  return -2 * Math.log1p((z * z) / 3);
}

function scoreCandidate(
  candidate: TeeRecoveryCandidate,
  badge: BadgeEvidence,
  consideredComponents: number,
  distanceModel: RobustModel,
  axisModel: RobustModel
): PosteriorCandidate {
  const fit = candidate.localizationFit ?? candidate.fit;
  const centerYPx = fit.centerYPx + (candidate.coordinateFrame === 'original' ? 0 : candidate.viewportTopPx ?? 0);
  const distancePx = Math.hypot(fit.centerXPx - badge.cxPx, centerYPx - badge.cyPx);
  const axisError = axisErrorDeg(candidate);
  const unexplainedPixels = candidate.fragmentPixels.filter((point) => !explains(candidate, point)).length;

  // These are deliberately likelihood TERMS rather than admissions.  No term
  // below can independently accept or reject a candidate.
  const supportTerm = 2 * Math.log1p(candidate.fragmentPixels.length);
  const distanceZ = (distancePx - distanceModel.median) / distanceModel.scale;
  const distanceTerm = studentTLikeLogLikelihood(distanceZ);
  const axisValue = axisError ?? axisModel.median + 3 * axisModel.scale;
  const axisZ = (axisValue - axisModel.median) / axisModel.scale;
  const axisTerm = -0.5 * axisZ * axisZ;
  const contradictionTerm = -Math.LN2 * unexplainedPixels; // each visible contradiction halves odds
  const multiplicityAndPriorTerm = Math.log(OBSERVABLE_TO_NULL_PRIOR_ODDS) - Math.log(Math.max(1, consideredComponents));
  const logWeightVsNull = supportTerm + distanceTerm + axisTerm + contradictionTerm + multiplicityAndPriorTerm;

  return {
    kind: 'candidate',
    id: candidate.id,
    badgeId: badge.detId,
    hole: badge.label,
    componentLabels: componentLabels(candidate),
    centerXPx: fit.centerXPx,
    centerYPx,
    supportPixels: candidate.fragmentPixels.length,
    unexplainedPixels,
    distancePx,
    axisErrorDeg: axisError,
    logTerms: {
      support: supportTerm,
      distance: distanceTerm,
      axis: axisTerm,
      contradictions: contradictionTerm,
      multiplicityAndPrior: multiplicityAndPriorTerm
    },
    logWeightVsNull
  };
}

function normalize(hypotheses: Hypothesis[]): Hypothesis[] {
  const maxLog = Math.max(0, ...hypotheses.map((hypothesis) => hypothesis.logWeightVsNull));
  const weights = hypotheses.map((hypothesis) => Math.exp(hypothesis.logWeightVsNull - maxLog));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  hypotheses.forEach((hypothesis, index) => { hypothesis.posterior = weights[index] / total; });
  return hypotheses.sort((a, b) => (b.posterior ?? 0) - (a.posterior ?? 0));
}

function sharesEvidence(a: Hypothesis, used: ReadonlySet<number>): boolean {
  return a.componentLabels.some((label) => used.has(label));
}

function enumerateJoint(
  byTarget: readonly { badgeId: string; hole: string | null; hypotheses: readonly Hypothesis[] }[]
): Array<{ logWeight: number; selections: Hypothesis[] }> {
  const out: Array<{ logWeight: number; selections: Hypothesis[] }> = [];
  function visit(index: number, used: Set<number>, selections: Hypothesis[], logWeight: number): void {
    if (index === byTarget.length) {
      out.push({ logWeight, selections: [...selections] });
      return;
    }
    const choices = byTarget[index].hypotheses.slice(0, TOP_K_PER_TARGET_FOR_JOINT);
    for (const hypothesis of choices) {
      if (sharesEvidence(hypothesis, used)) continue;
      const nextUsed = new Set(used);
      for (const label of hypothesis.componentLabels) nextUsed.add(label);
      selections.push(hypothesis);
      visit(index + 1, nextUsed, selections, logWeight + hypothesis.logWeightVsNull);
      selections.pop();
    }
  }
  visit(0, new Set(), [], 0);
  return out.sort((a, b) => b.logWeight - a.logWeight);
}

async function inferCourse(course: 'Heritage' | 'AlexClark', imageName: string) {
  const loaded = loadConfig(CONFIG);
  const input = resolve(CORPUS, 'dev', course, imageName);
  const { image, report } = await canonicalizeInputs([input], undefined);
  const board = createExecBoard();
  seedBoard(board as unknown as EvidenceBoard, image, resolveConfiguredParams(undefined, loaded.resolved));
  board.set('recoveredTees', []);
  board.set('straightTestTruthAssistance', { mode: 'blind', locks: [] });
  const tmp = mkdtempSync(resolve(tmpdir(), `chainspot-posterior-${course}-`));
  try {
    const { ctx } = createTraceContext(loaded.resolved, loaded.plan.paramsHash ?? '', loaded.plan.ops, {
      imageId: report.imageId,
      canonicalFrame: 'G0 canonical detector-input pixels'
    });
    executeCompiledPlan(loaded.plan, board, ctx, createNodeSink(tmp));
    const badges = board.get<readonly BadgeEvidence[]>('badges');
    const baskets = board.get<readonly BasketEvidence[]>('baskets');
    const visibleTees = board.get<readonly TeeEvidence[]>('tees');
    const measurement = board.get<ThreeFactorMeasurement>('measurement');
    const assignment = board.get<ThreeFactorAssignment>('assignment');
    const teeBadge = board.get<TeeBadgeEvidenceLike>('teeBadgeLock');
    const stage = board.get<unknown>('stage');
    const viewport = board.get<{ readonly topPx: number }>('viewport');
    const sprites = board.has('sprites') ? board.get<readonly SpriteMatch[]>('sprites') : undefined;

    const visibleLocks = teeBadge.locks.filter((lock) => lock.tier === 'visible');
    const distanceModel = robustModel(
      visibleLocks.map((lock) => lock.chordPx),
      1,
      `median/MAD over ${visibleLocks.length} frozen visible teeBadgeLock chordPx values`
    );
    const axisSamples = visibleLocks
      .map((lock) => lock.axisErrorDeg)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    const axisModel = robustModel(
      axisSamples,
      0.5,
      `median/MAD over ${axisSamples.length} frozen visible teeBadgeLock axis-error values`
    );

    // Conflict-island discovery is evidence-only. A current abstention is an
    // island seed. A recovered tee whose final lock disagrees with the badge
    // that assignment associated it with seeds the lock holder as well; if
    // the assignment holder lacks a lock, that badge is also unresolved.
    const targetBadgeIds = new Set<string>(teeBadge.abstentions.map((row) => row.badgeId));
    const lockByBadge = new Map(teeBadge.locks.map((row) => [row.badgeId, row]));
    const assignmentByTee = new Map(assignment.assignments.map((row) => [row.teeId, row]));
    for (const lock of teeBadge.locks) {
      if (lock.tier !== 'recovered') continue;
      const assignmentOwner = assignmentByTee.get(lock.teeId);
      if (!assignmentOwner || assignmentOwner.badgeId === lock.badgeId) continue;
      targetBadgeIds.add(lock.badgeId);
      if (!lockByBadge.has(assignmentOwner.badgeId)) targetBadgeIds.add(assignmentOwner.badgeId);
    }

    const basketFallback = baskets[0]?.detId ?? 'UNKNOWN';
    const assignmentMask = {
      assignments: badges
        .filter((badge) => /^\d+$/.test(badge.label ?? '') && !targetBadgeIds.has(badge.detId))
        .map((badge) => ({ badgeId: badge.detId, basketId: basketFallback }))
    };
    const built = buildTeeRecoveryCandidates(
      stage as Parameters<typeof buildTeeRecoveryCandidates>[0],
      badges,
      baskets,
      visibleTees,
      viewport.topPx,
      { assignment: assignmentMask, sprites, occlusion: ctx.occlusion }
    );

    const posteriorTargets = built.searchOutcomes
      .filter((outcome) => targetBadgeIds.has(outcome.badgeId))
      .map((outcome) => {
        const badge = badges.find((candidate) => candidate.detId === outcome.badgeId)!;
        const raw = [outcome.winner, ...outcome.runnerUps].filter((value): value is TeeRecoveryCandidate => value !== undefined);
        const hypotheses: Hypothesis[] = raw.map((candidate) =>
          scoreCandidate(candidate, badge, outcome.consideredComponents, distanceModel, axisModel)
        );
        hypotheses.push({
          kind: 'null', id: 'NULL', badgeId: badge.detId, hole: badge.label,
          componentLabels: [], logWeightVsNull: 0
        });
        return {
          badgeId: badge.detId,
          hole: badge.label,
          consideredComponents: outcome.consideredComponents,
          hypotheses: normalize(hypotheses)
        };
      });

    const joint = enumerateJoint(posteriorTargets);
    const topJoint = joint[0];
    const maxJoint = topJoint?.logWeight ?? 0;
    const jointNorm = joint.slice(0, 100).map((row) => ({ ...row, weight: Math.exp(row.logWeight - maxJoint) }));
    const jointDenom = jointNorm.reduce((sum, row) => sum + row.weight, 0);
    const jointTop = jointNorm.slice(0, 10).map((row) => ({
      posteriorWithinTop100: row.weight / jointDenom,
      logWeight: row.logWeight,
      selections: row.selections.map((selection) => ({
        kind: selection.kind,
        id: selection.id,
        hole: selection.hole,
        badgeId: selection.badgeId,
        posterior: selection.posterior,
        componentLabels: selection.componentLabels,
        ...(selection.kind === 'candidate' ? {
          centerXPx: selection.centerXPx,
          centerYPx: selection.centerYPx,
          supportPixels: selection.supportPixels,
          unexplainedPixels: selection.unexplainedPixels,
          distancePx: selection.distancePx,
          axisErrorDeg: selection.axisErrorDeg,
          logWeightVsNull: selection.logWeightVsNull,
          logTerms: selection.logTerms
        } : {})
      }))
    }));

    const nullSelections = topJoint?.selections.filter((selection) => selection.kind === 'null') ?? [];
    const phantoms = nullSelections.length
      ? synthesizePhantomTees(measurement, assignment.assignments, 0, nullSelections.length)
      : [];

    const output = {
      schema: 'posterior-tee-recovery-inference@1',
      course,
      imageId: report.imageId,
      frozenBaseline: {
        locks: teeBadge.locks.length,
        abstentions: teeBadge.abstentions,
        recoveredLocks: teeBadge.locks.filter((lock) => lock.tier === 'recovered')
      },
      evidenceModels: { distance: distanceModel, axis: axisModel },
      targetBadgeIds: [...targetBadgeIds],
      targets: posteriorTargets.map((target) => ({
        badgeId: target.badgeId,
        hole: target.hole,
        consideredComponents: target.consideredComponents,
        topHypotheses: target.hypotheses.slice(0, 12).map((hypothesis) => ({
          ...hypothesis,
          // component geometry/pixels stay out of this compact receipt; IDs
          // make the source hypothesis auditable in the surface artifact.
        }))
      })),
      jointTop,
      genericPhantomsForNullSelections: phantoms
    };
    return output;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe('posterior tee recovery inference spike', () => {
  test('runs blind posterior recovery on the two frozen-106 conflict courses', async () => {
    const heritage = await inferCourse('Heritage', 'HeritagePark-full.png');
    const alex = await inferCourse('AlexClark', 'AlexClark-full.jpg');
    const outDir = resolve(ROOT, 'artifacts/spikes/posterior-tee-recovery');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, 'posterior-inference-receipt.json'), JSON.stringify({ heritage, alex }, null, 2) + '\n');
    console.log(JSON.stringify({
      Heritage: heritage.jointTop[0],
      AlexClark: alex.jointTop[0],
      AlexNullPhantoms: alex.genericPhantomsForNullSelections.length
    }, null, 2));
    expect(heritage.jointTop.length).toBeGreaterThan(0);
    expect(alex.jointTop.length).toBeGreaterThan(0);
  }, 300_000);
});
