import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { createExecBoard, executeCompiledPlan } from '@chainspot/alg/exec';
import { createNodeSink } from '@chainspot/alg/exec/node-sink';
import { createTraceContext, resolveConfiguredParams } from '@chainspot/alg/detectors/threeFactor/engine';
import { seedBoard } from '@chainspot/alg/detectors/threeFactor/measure';
import type { EvidenceBoard } from '@chainspot/alg/detectors/threeFactor/features/types';
import type { BadgeEvidence, BasketEvidence, TeeEvidence, ThreeFactorAssignment } from '@chainspot/alg/detectors/threeFactor/types';
import type { SpriteMatch } from '@chainspot/alg/detectors/threeFactor/endpoints';
import {
  buildTeeRecoveryCandidates,
  type TeeRecoveryCandidate
} from '@chainspot/alg/detectors/threeFactor/features/g3.teeRecovery';
import { loadConfig } from '../../scripts/chainspot-lab/sweep/configIo';
import { canonicalizeInputs } from '../../scripts/chainspot-lab/sweep/inputShim';

const ROOT = resolve(import.meta.dirname, '../..');
const DEFAULT_CONFIG = resolve(ROOT, 'packages/alg/src/detectors/threeFactor/configs/default.json');
const CORPUS_ROOT = process.env.CHAINSPOT_CORPUS_ROOT
  ? resolve(process.env.CHAINSPOT_CORPUS_ROOT)
  : resolve(ROOT, '..', 'chainspot-corpus');
const RASTER_TOLERANCE_PX = 1.25;

interface LockLike {
  readonly badgeId: string;
  readonly teeId: string;
  readonly hole?: number;
  readonly score: number;
  readonly tier?: string;
}
interface AbstentionLike {
  readonly badgeId: string;
  readonly hole?: number;
  readonly bestTeeId?: string;
  readonly winningBadgeId?: string;
}
interface TeeBadgeEvidenceLike {
  readonly locks: readonly LockLike[];
  readonly abstentions: readonly AbstentionLike[];
}

function axisErrorDeg(candidate: TeeRecoveryCandidate): number | null {
  const a = candidate.badgeAxisAngleRad;
  const b = candidate.teeToBadgeAngleRad;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const d = Math.atan2(Math.sin((a as number) - (b as number)), Math.cos((a as number) - (b as number)));
  return Math.abs(d) * 180 / Math.PI;
}

function pixelResidual(candidate: TeeRecoveryCandidate, point: readonly [number, number]): number {
  const fit = candidate.fit;
  const dx = point[0] - fit.centerXPx;
  const dy = point[1] - fit.centerYPx;
  const c = Math.cos(fit.angleRad);
  const s = Math.sin(fit.angleRad);
  const u = dx * c + dy * s;
  const v = -dx * s + dy * c;
  const absU = Math.abs(u);
  const absV = Math.abs(v);
  const outer = Math.hypot(
    Math.max(0, absU - fit.halfWidthPx),
    Math.max(0, absV - fit.halfHeightPx)
  );
  const edge = Math.min(
    Math.abs(absU - fit.halfWidthPx),
    Math.abs(absV - fit.halfHeightPx)
  );
  return outer * 4 + edge;
}

function explained(candidate: TeeRecoveryCandidate, point: readonly [number, number]): boolean {
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

function summarize(candidate: TeeRecoveryCandidate) {
  const residuals = candidate.fragmentPixels.map((point) => pixelResidual(candidate, point));
  const unexplained = candidate.fragmentPixels.filter((point) => !explained(candidate, point)).length;
  const fit = candidate.localizationFit ?? candidate.fit;
  return {
    id: candidate.id,
    badgeId: candidate.badgeId,
    hole: candidate.badgeLabel,
    componentSet: candidate.supportingComponentIds.map((id) => id.split(':')[0]).sort().join('+'),
    supportPixels: candidate.fragmentPixels.length,
    unexplainedPixels: unexplained,
    explainedFraction: candidate.fragmentPixels.length ? 1 - unexplained / candidate.fragmentPixels.length : 0,
    meanResidualPx: residuals.length ? residuals.reduce((a, b) => a + b, 0) / residuals.length : Number.POSITIVE_INFINITY,
    axisErrorDeg: axisErrorDeg(candidate),
    centerXPx: fit.centerXPx,
    centerYPx: fit.centerYPx + (candidate.coordinateFrame === 'original' ? 0 : candidate.viewportTopPx ?? 0),
    ambiguityLostToBadgeLabel: candidate.ambiguityLostToBadgeLabel ?? null,
    localizationSource: candidate.localizationSource ?? 'support-fit'
  };
}

async function runHeritageProbe() {
  const loaded = loadConfig(DEFAULT_CONFIG);
  const input = resolve(CORPUS_ROOT, 'dev/Heritage/HeritagePark-full.png');
  const { image, report } = await canonicalizeInputs([input], undefined);
  const board = createExecBoard();
  seedBoard(board as unknown as EvidenceBoard, image, resolveConfiguredParams(undefined, loaded.resolved));
  board.set('recoveredTees', []);
  board.set('straightTestTruthAssistance', { mode: 'blind', locks: [] });

  const tmp = mkdtempSync(resolve(tmpdir(), 'chainspot-posterior-recovery-'));
  const sink = createNodeSink(tmp);
  const { ctx } = createTraceContext(loaded.resolved, loaded.plan.paramsHash ?? '', loaded.plan.ops, {
    imageId: report.imageId,
    canonicalFrame: 'G0 canonical detector-input pixels'
  });
  try {
    executeCompiledPlan(loaded.plan, board, ctx, sink);

    const badges = board.get<readonly BadgeEvidence[]>('badges');
    const baskets = board.get<readonly BasketEvidence[]>('baskets');
    const visibleTees = board.get<readonly TeeEvidence[]>('tees');
    const assignment = board.get<ThreeFactorAssignment>('assignment');
    const teeBadge = board.get<TeeBadgeEvidenceLike>('teeBadgeLock');
    const stage = board.get<unknown>('stage');
    const viewport = board.get<{ readonly topPx: number }>('viewport');
    const sprites = board.has('sprites') ? board.get<readonly SpriteMatch[]>('sprites') : undefined;

    // Derive the conflict island from evidence, not course/hole constants:
    //   * every teeBadgeLock abstention;
    //   * the badge currently holding a recovered tee that the abstention's
    //     ordinary assignment says belongs to the abstaining badge;
    //   * any badge still absent from the post-recovery assignment.
    const targetBadgeIds = new Set<string>();
    const assignmentByBadge = new Map(assignment.assignments.map((row) => [row.badgeId, row]));
    const lockByTee = new Map(teeBadge.locks.map((row) => [row.teeId, row]));
    for (const abstention of teeBadge.abstentions) {
      targetBadgeIds.add(abstention.badgeId);
      const routeRow = assignmentByBadge.get(abstention.badgeId);
      if (routeRow?.teeId.startsWith('tee-recovered-')) {
        const competingLock = lockByTee.get(routeRow.teeId);
        if (competingLock) targetBadgeIds.add(competingLock.badgeId);
      }
    }
    for (const badge of badges) {
      if (/^\d+$/.test(badge.label ?? '') && !assignmentByBadge.has(badge.detId)) targetBadgeIds.add(badge.detId);
    }

    // buildTeeRecoveryCandidates uses assignment only to decide WHICH badges
    // deserve recovery search. Mark every non-island badge as already handled,
    // leaving the actual raster evidence and candidate geometry untouched.
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

    const targets = built.searchOutcomes.map((outcome) => {
      const all = [outcome.winner, ...outcome.runnerUps].filter((x): x is TeeRecoveryCandidate => x !== undefined);
      const rows = all.map(summarize).sort((a, b) =>
        b.explainedFraction - a.explainedFraction ||
        a.meanResidualPx - b.meanResidualPx ||
        (a.axisErrorDeg ?? Number.POSITIVE_INFINITY) - (b.axisErrorDeg ?? Number.POSITIVE_INFINITY) ||
        b.supportPixels - a.supportPixels ||
        a.componentSet.localeCompare(b.componentSet)
      );
      return {
        badgeId: outcome.badgeId,
        hole: outcome.badgeLabel,
        consideredComponents: outcome.consideredComponents,
        currentWinner: outcome.winner ? summarize(outcome.winner) : null,
        topPosteriorInputs: rows.slice(0, 25)
      };
    });

    const out = {
      schema: 'posterior-tee-recovery-probe@1',
      imageId: report.imageId,
      targetBadgeIds: [...targetBadgeIds],
      teeBadgeAbstentions: teeBadge.abstentions,
      currentAssignmentRows: assignment.assignments.filter((row) => targetBadgeIds.has(row.badgeId)),
      currentLocks: teeBadge.locks.filter((row) => targetBadgeIds.has(row.badgeId)),
      targets
    };
    const outDir = resolve(ROOT, 'artifacts/spikes/posterior-tee-recovery');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, 'heritage-candidate-surface.json'), JSON.stringify(out, null, 2) + '\n');
    console.log(JSON.stringify(out, null, 2));
    return out;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe('posterior tee recovery spike', () => {
  test('exposes the whole Heritage conflict-island candidate surface without changing the frozen default', async () => {
    const out = await runHeritageProbe();
    expect(out.teeBadgeAbstentions).toHaveLength(1);
    expect(out.targets.length).toBeGreaterThanOrEqual(2);
    expect(out.targets.every((target) => target.topPosteriorInputs.length > 0)).toBe(true);
  }, 180_000);
});
