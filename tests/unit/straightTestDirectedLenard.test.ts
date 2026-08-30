import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
	DEFAULT_EXECUTION,
	canonicalJson,
	parseConfig,
	resolveConfig,
	runThreeFactor,
	sha256Hex
} from '@chainspot/alg/detectors/threeFactor';
import straightOn from '@chainspot/alg/detectors/threeFactor/configs/straight-test-on.json';
import { straightTestFeature } from '@chainspot/alg/detectors/threeFactor/features/st.straightTest';
import { runSweepOperation } from '../../scripts/chainspot-lab/sweep/operation';
import { COURSES, loadCourseRaster, loadCourseTruth } from './helpers/courseFixture';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const CORPUS_ROOT = resolve(REPO_ROOT, '../chainspot-corpus');
const LENARD_IMAGE = resolve(CORPUS_ROOT, 'dev/Annotated/Lenard/Lenard-full.PNG');
const CONFIG_PATH = resolve(
	REPO_ROOT,
	'packages/alg/src/detectors/threeFactor/configs/straight-test-on.json'
);
const ARTIFACTS_DIR = resolve(REPO_ROOT, 'artifacts/sweep/straight-test-lenard');
const TOLERANCE_PX = 26;

const lenard = COURSES.find((course) => course.name === 'Lenard');
if (!lenard) throw new Error('Lenard fixture missing');

function distance(
	a: { readonly xPx: number; readonly yPx: number },
	b: { readonly xPx: number; readonly yPx: number }
): number {
	return Math.hypot(a.xPx - b.xPx, a.yPx - b.yPx);
}

describe('directed-corridor Straight Test — Lenard', () => {
	test(
		'production feature resolves all 18 straight basket TIPs and owns its render testimony',
		async () => {
			const raster = loadCourseRaster(lenard);
			const truth = loadCourseTruth(lenard).holes;
			const resolved = resolveConfig(parseConfig(straightOn), DEFAULT_EXECUTION);
			const paramsHash = await sha256Hex(canonicalJson(resolved));
			const run = runThreeFactor(raster, { config: resolved, paramsHash });
			const trace = run.trace;
			if (!trace) throw new Error('Straight Test run produced no trace');
			const straight = trace.straightTest;
			if (!straight) throw new Error('Straight Test trace missing');

			const selected = straight.proposals.filter((proposal) => proposal.selected);
			expect(straight.truthAssistance.mode).toBe('blind');
			expect(straight.proposals).toHaveLength(18);
			expect(selected).toHaveLength(18);
			expect(new Set(selected.map((proposal) => proposal.basketId)).size).toBe(18);

			const basketById = new Map(run.measurement.baskets.map((basket) => [basket.detId, basket]));
			const rows = selected
				.map((proposal) => {
					const hole = truth.find((candidate) => String(candidate.number) === proposal.holeLabel);
					const basket = proposal.basketId ? basketById.get(proposal.basketId) : undefined;
					if (!hole || !basket) throw new Error(`missing evaluator row for ${proposal.proposalId}`);
					return {
						hole: hole.number,
						basketId: basket.detId,
						truthDistancePx: distance(hole.basket, {
							xPx: basket.tipXPx,
							yPx: basket.tipYPx
						}),
						alongPx: proposal.straightRay?.selectedAlongPx ?? null,
						perpendicularPx: proposal.straightRay?.selectedPerpendicularPx ?? null,
						corridorCandidates: proposal.straightRay?.corridorCandidateCount ?? 0,
						nextTipMarginPx: proposal.straightRay?.nextTipMarginPx ?? null
					};
				})
				.sort((a, b) => a.hole - b.hole);
			expect(rows.every((row) => row.truthDistancePx <= TOLERANCE_PX)).toBe(true);

			const unit = trace.units.find((candidate) => candidate.id === 'straightTest');
			if (!unit) throw new Error('Straight Test UnitTrace missing');
			expect(straightTestFeature.render).toBeTruthy();
			const plan = straightTestFeature.render!.draw(unit, trace);
			expect(plan.base).toBe('badgeStage.masks.localImage');
			expect(plan.title).toMatch(/first basket TIP/i);
			const roleCount = (role: string) =>
				unit.drawables.filter((drawable) => drawable.metadata?.straightRole === role).length;
			expect(roleCount('straight-route')).toBe(18);
			expect(roleCount('winning-basket-tip')).toBe(18);
			expect(roleCount('corridor-edge')).toBe(36);
			expect(roleCount('straight-abstention')).toBe(0);

			mkdirSync(ARTIFACTS_DIR, { recursive: true });
			writeFileSync(
				resolve(ARTIFACTS_DIR, 'Lenard.straight-test.summary.json'),
				JSON.stringify({ paramsHash, rows, renderTitle: plan.title }, null, 2)
			);
			console.log(`LENARD_STRAIGHT_TEST_SELECTED=${selected.length}`);
			console.log(`LENARD_STRAIGHT_TEST_RENDER_ROUTES=${roleCount('straight-route')}`);
		},
		120_000
	);

	test(
		'real Sweep writes the feature-owned Straight Test VisualRender',
		async () => {
			rmSync(resolve(ARTIFACTS_DIR, 'sweep'), { recursive: true, force: true });
			const result = await runSweepOperation({
				configPath: CONFIG_PATH,
				inputPaths: [LENARD_IMAGE],
				outDir: resolve(ARTIFACTS_DIR, 'sweep')
			});
			const files = result.featureRenders.results.flatMap((entry) => entry.filesWritten);
			const pngs = files.filter((path) => path.endsWith('.png'));
			const visualReceipts = files.filter((path) => path.endsWith('run.visual.receipt.txt'));
			expect(pngs.length).toBeGreaterThan(0);
			expect(visualReceipts.length).toBeGreaterThan(0);
			expect(result.trace.straightTest?.proposals.filter((proposal) => proposal.selected)).toHaveLength(18);
			console.log(`LENARD_STRAIGHT_TEST_VISUAL_PNG=${pngs[0]}`);
			console.log(`LENARD_STRAIGHT_TEST_VISUAL_RECEIPT=${visualReceipts[0]}`);
		},
		120_000
	);
});
