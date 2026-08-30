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
import { runSweepOperation } from '../../scripts/chainspot-lab/sweep/operation';
import {
	DASHSTRACK_VIA_ANNOTATED,
	loadCourseRaster,
	loadCourseTruth
} from './helpers/courseFixture';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const CORPUS_ROOT = resolve(REPO_ROOT, '../chainspot-corpus');
const DASHS_IMAGE = resolve(CORPUS_ROOT, 'dev/Annotated/DashsTrack/DashsTrack-full.jpg');
const CONFIG_PATH = resolve(
	REPO_ROOT,
	'packages/alg/src/detectors/threeFactor/configs/straight-test-on.json'
);
const ARTIFACTS_DIR = resolve(REPO_ROOT, 'artifacts/sweep/straight-test-dashs');
const ENDPOINT_TOLERANCE_PX = 26;

type Point = { readonly xPx: number; readonly yPx: number };
type DashHole = {
	readonly number: number;
	readonly tee: Point;
	readonly basket: Point;
	readonly corridorBends: readonly Point[];
};

function distance(a: Point, b: Point): number {
	return Math.hypot(a.xPx - b.xPx, a.yPx - b.yPx);
}

describe("directed-corridor Straight Test — Dash's Track", () => {
	test(
		'blindly records where the straight hypothesis succeeds and fails before truth classification',
		async () => {
			const raster = loadCourseRaster(DASHSTRACK_VIA_ANNOTATED);
			const truth = loadCourseTruth(DASHSTRACK_VIA_ANNOTATED).holes as readonly DashHole[];
			const resolved = resolveConfig(parseConfig(straightOn), DEFAULT_EXECUTION);
			const paramsHash = await sha256Hex(canonicalJson(resolved));
			const run = runThreeFactor(raster, { config: resolved, paramsHash });
			const straight = run.trace?.straightTest;
			if (!straight) throw new Error('Straight Test trace missing');

			// Everything above is blind. Ground truth enters only here to label the
			// already-emitted proposal and to separate known 0-bend from bent holes.
			const basketById = new Map(run.measurement.baskets.map((basket) => [basket.detId, basket]));
			const rows = [...truth]
				.sort((a, b) => a.number - b.number)
				.map((hole) => {
					const proposal = straight.proposals.find((candidate) => candidate.holeLabel === String(hole.number));
					const trueDetected = [...run.measurement.baskets]
						.map((basket) => ({
							basket,
							distancePx: distance(hole.basket, { xPx: basket.tipXPx, yPx: basket.tipYPx })
						}))
						.sort((a, b) => a.distancePx - b.distancePx)[0];
					if (!trueDetected || trueDetected.distancePx > ENDPOINT_TOLERANCE_PX) {
						throw new Error(`H${hole.number}: no detected basket TIP within ${ENDPOINT_TOLERANCE_PX}px of truth`);
					}
					const proposedBasket = proposal?.basketId ? basketById.get(proposal.basketId) : undefined;
					const proposedTruthDistancePx = proposedBasket
						? distance(hole.basket, { xPx: proposedBasket.tipXPx, yPx: proposedBasket.tipYPx })
						: null;
					const correctEndpoint = proposal?.basketId === trueDetected.basket.detId;
					return {
						hole: hole.number,
						bends: hole.corridorBends.length,
						zeroBendTruth: hole.corridorBends.length === 0,
						proposalId: proposal?.proposalId ?? 'MISSING',
						selected: proposal?.selected ?? false,
						proposedBasketId: proposal?.basketId ?? null,
						trueBasketId: trueDetected.basket.detId,
						correctEndpoint,
						proposedTruthDistancePx:
							proposedTruthDistancePx === null ? null : Number(proposedTruthDistancePx.toFixed(2)),
						alongPx: proposal?.straightRay?.selectedAlongPx ?? null,
						perpendicularPx: proposal?.straightRay?.selectedPerpendicularPx ?? null,
						corridorCandidates: proposal?.straightRay?.corridorCandidateCount ?? 0,
						nextTipMarginPx: proposal?.straightRay?.nextTipMarginPx ?? null,
						disposition: !proposal?.basketId
							? 'NO_FORWARD_TIP'
							: !proposal.selected
								? correctEndpoint
									? 'CORRECT_LOCAL_BUT_ABSTAINED'
									: 'WRONG_LOCAL_AND_ABSTAINED'
								: correctEndpoint
									? 'SELECTED_CORRECT'
									: 'SELECTED_WRONG'
					};
				});

			const zero = rows.filter((row) => row.zeroBendTruth);
			const bent = rows.filter((row) => !row.zeroBendTruth);
			const summary = {
				holes: rows.length,
				zeroBendTruth: zero.length,
				bentTruth: bent.length,
				proposals: straight.proposals.length,
				selected: rows.filter((row) => row.selected).length,
				localCorrectAll: rows.filter((row) => row.correctEndpoint).length,
				zeroBendLocalCorrect: zero.filter((row) => row.correctEndpoint).length,
				zeroBendSelectedCorrect: zero.filter((row) => row.selected && row.correctEndpoint).length,
				zeroBendWrong: zero.filter((row) => row.proposedBasketId && !row.correctEndpoint).length,
				zeroBendNoTip: zero.filter((row) => !row.proposedBasketId).length,
				bentLocalCorrect: bent.filter((row) => row.correctEndpoint).length,
				bentSelectedCorrect: bent.filter((row) => row.selected && row.correctEndpoint).length,
				bentWrong: bent.filter((row) => row.proposedBasketId && !row.correctEndpoint).length,
				bentNoTip: bent.filter((row) => !row.proposedBasketId).length
			};

			console.table(rows);
			console.log(`DASHS_STRAIGHT_TEST_SUMMARY=${JSON.stringify(summary)}`);
			mkdirSync(ARTIFACTS_DIR, { recursive: true });
			writeFileSync(
				resolve(ARTIFACTS_DIR, 'DashsTrack.straight-test.summary.json'),
				JSON.stringify({ paramsHash, truthUse: 'evaluator only after blind proposals', summary, rows }, null, 2)
			);

			// This first Dashs run is observational. Assert only fixture integrity and
			// that Straight Test actually ran; do not encode the result as a target.
			expect(truth).toHaveLength(18);
			expect(zero).toHaveLength(9);
			expect(bent).toHaveLength(9);
			expect(run.measurement.baskets).toHaveLength(18);
			expect(straight.proposals.length).toBeGreaterThan(0);
		},
		120_000
	);

	test(
		'real Sweep renders Dashs Straight Test testimony',
		async () => {
			rmSync(resolve(ARTIFACTS_DIR, 'sweep'), { recursive: true, force: true });
			const result = await runSweepOperation({
				configPath: CONFIG_PATH,
				inputPaths: [DASHS_IMAGE],
				outDir: resolve(ARTIFACTS_DIR, 'sweep')
			});
			const files = result.featureRenders.results.flatMap((entry) => entry.filesWritten);
			const pngs = files.filter((path) => path.endsWith('.png'));
			const receipts = files.filter((path) => path.endsWith('run.visual.receipt.txt'));
			expect(pngs.length).toBeGreaterThan(0);
			expect(receipts.length).toBeGreaterThan(0);
			console.log(`DASHS_STRAIGHT_TEST_VISUAL_PNG=${pngs[0]}`);
			console.log(`DASHS_STRAIGHT_TEST_VISUAL_RECEIPT=${receipts[0]}`);
		},
		120_000
	);
});
