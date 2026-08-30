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
import { buildTeeRecoveryCandidates, type TeeRecoveryCandidate } from '@chainspot/alg/detectors/threeFactor/features/g3.teeRecovery';
import { loadConfig } from '../../scripts/chainspot-lab/sweep/configIo';
import { canonicalizeInputs } from '../../scripts/chainspot-lab/sweep/inputShim';

const ROOT = resolve(import.meta.dirname, '../..');
const CONFIG = resolve(ROOT, 'packages/alg/src/detectors/threeFactor/configs/default.json');
const CORPUS = resolve(process.env.CHAINSPOT_CORPUS_ROOT ?? resolve(ROOT, '..', 'chainspot-corpus'));
const RASTER_TOLERANCE_PX = 1.25;

interface TeeBadgeEvidenceLike {
  readonly locks: readonly { readonly badgeId: string; readonly teeId: string }[];
  readonly abstentions: readonly { readonly badgeId: string }[];
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

function summarize(candidate: TeeRecoveryCandidate) {
  const fit = candidate.localizationFit ?? candidate.fit;
  const unexplained = candidate.fragmentPixels.filter((point) => !explains(candidate, point)).length;
  const rawComponentLabels = candidate.supportingComponentIds.map((id) => Number(id.split(':')[0])).filter(Number.isFinite);
  const componentLabels = [...new Set(rawComponentLabels)].sort((a, b) => a - b);
  return {
    id: candidate.id,
    badgeId: candidate.badgeId,
    hole: candidate.badgeLabel,
    componentLabels,
    supportPixels: candidate.fragmentPixels.length,
    unexplainedPixels: unexplained,
    explainedFraction: candidate.fragmentPixels.length ? 1 - unexplained / candidate.fragmentPixels.length : 0,
    axisErrorDeg: axisErrorDeg(candidate),
    centerXPx: fit.centerXPx,
    centerYPx: fit.centerYPx + (candidate.coordinateFrame === 'original' ? 0 : candidate.viewportTopPx ?? 0),
    halfWidthPx: fit.halfWidthPx,
    halfHeightPx: fit.halfHeightPx,
    supportThicknessPx: fit.supportThicknessPx ?? null,
    localizationSource: candidate.localizationSource ?? 'support-fit',
    ambiguityLostToBadgeLabel: candidate.ambiguityLostToBadgeLabel ?? null
  };
}

describe('posterior tee recovery material hypothesis surface', () => {
  test('preserves every >=8-pixel hypothesis in the evidence-derived Heritage conflict island', async () => {
    const loaded = loadConfig(CONFIG);
    const input = resolve(CORPUS, 'dev/Heritage/HeritagePark-full.png');
    const { image, report } = await canonicalizeInputs([input], undefined);
    const board = createExecBoard();
    seedBoard(board as unknown as EvidenceBoard, image, resolveConfiguredParams(undefined, loaded.resolved));
    board.set('recoveredTees', []);
    board.set('straightTestTruthAssistance', { mode: 'blind', locks: [] });
    const tmp = mkdtempSync(resolve(tmpdir(), 'chainspot-posterior-surface-'));
    try {
      const sink = createNodeSink(tmp);
      const { ctx } = createTraceContext(loaded.resolved, loaded.plan.paramsHash ?? '', loaded.plan.ops, {
        imageId: report.imageId,
        canonicalFrame: 'G0 canonical detector-input pixels'
      });
      executeCompiledPlan(loaded.plan, board, ctx, sink);

      const badges = board.get<readonly BadgeEvidence[]>('badges');
      const baskets = board.get<readonly BasketEvidence[]>('baskets');
      const visibleTees = board.get<readonly TeeEvidence[]>('tees');
      const assignment = board.get<ThreeFactorAssignment>('assignment');
      const teeBadge = board.get<TeeBadgeEvidenceLike>('teeBadgeLock');
      const stage = board.get<unknown>('stage');
      const viewport = board.get<{ readonly topPx: number }>('viewport');
      const sprites = board.has('sprites') ? board.get<readonly SpriteMatch[]>('sprites') : undefined;

      const targetBadgeIds = new Set<string>();
      const assignmentByBadge = new Map(assignment.assignments.map((row) => [row.badgeId, row]));
      const lockByTee = new Map(teeBadge.locks.map((row) => [row.teeId, row]));
      for (const abstention of teeBadge.abstentions) {
        targetBadgeIds.add(abstention.badgeId);
        const assigned = assignmentByBadge.get(abstention.badgeId);
        if (assigned?.teeId.startsWith('tee-recovered-')) {
          const holder = lockByTee.get(assigned.teeId);
          if (holder) targetBadgeIds.add(holder.badgeId);
        }
      }
      for (const badge of badges) {
        if (/^\d+$/.test(badge.label ?? '') && !assignmentByBadge.has(badge.detId)) targetBadgeIds.add(badge.detId);
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

      const targets = built.searchOutcomes.map((outcome) => {
        const all = [outcome.winner, ...outcome.runnerUps].filter((value): value is TeeRecoveryCandidate => value !== undefined);
        const material = all
          .filter((candidate) => candidate.fragmentPixels.length >= 8)
          .map(summarize)
          .sort((a, b) => b.supportPixels - a.supportPixels || a.unexplainedPixels - b.unexplainedPixels || (a.axisErrorDeg ?? Infinity) - (b.axisErrorDeg ?? Infinity));
        return {
          badgeId: outcome.badgeId,
          hole: outcome.badgeLabel,
          currentWinner: outcome.winner ? summarize(outcome.winner) : null,
          materialHypotheses: material
        };
      });
      const out = {
        schema: 'posterior-tee-recovery-material-surface@1',
        imageId: report.imageId,
        targetBadgeIds: [...targetBadgeIds],
        targets
      };
      const outDir = resolve(ROOT, 'artifacts/spikes/posterior-tee-recovery');
      mkdirSync(outDir, { recursive: true });
      writeFileSync(resolve(outDir, 'heritage-material-surface.json'), JSON.stringify(out, null, 2) + '\n');
      console.log(JSON.stringify({
        targetBadgeIds: out.targetBadgeIds,
        counts: targets.map((target) => ({ hole: target.hole, materialHypotheses: target.materialHypotheses.length }))
      }));
      expect(targets.length).toBeGreaterThanOrEqual(2);
      expect(targets.every((target) => target.materialHypotheses.length > 0)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 180_000);
});
