import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { createExecBoard } from '@chainspot/alg/exec';
import type { CanonicalTruth } from '@chainspot/alg/g0/truth';
import type { BasketEvidence } from '@chainspot/alg/detectors/threeFactor/types';
import { g2SpriteFeature } from '@chainspot/alg/detectors/threeFactor/features/g2.sprite';
import {
	compileSweepConfig,
	runSweepOperation,
	slicePlanThroughGate
} from '../../scripts/chainspot-lab/sweep/operation';
import {
	associateDetections,
	compareTruthGrounding,
	type LocatedDetection,
	type TruthTarget
} from '../../scripts/chainspot-lab/sweep/truthScoring';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const CORPUS_ROOT = resolve(REPO_ROOT, '../chainspot-corpus');

describe('LAB sweep receipt seam', () => {
	test('through G2 selects badges and baskets without paying for G3-G5 or shared operations', async () => {
		const { plan } = compileSweepConfig(
			resolve(REPO_ROOT, 'packages/alg/src/detectors/threeFactor/configs/default.json')
		);
		const sliced = await slicePlanThroughGate(plan, 'G2');
		expect([...new Set(sliced.ops.map((operation) => operation.gate))]).toEqual(['G1', 'G2']);
		expect(sliced.ops.map((operation) => operation.id)).toEqual([
			'badgeStage.masks',
			'badgeStage.components',
			'badgeStage.family',
			'badgeStage.badges',
			'badges',
			'baskets'
		]);
	});

	test('smart G2 promotes a course-sized renderer family instead of sliding-window echoes', async () => {
		const result = await runSweepOperation({
			configPath: resolve(REPO_ROOT, 'packages/alg/src/detectors/threeFactor/configs/default.json'),
			inputPaths: [resolve(CORPUS_ROOT, 'dev/DashsTrack/DashsTrack-full.jpg')],
			outDir: resolve(REPO_ROOT, 'artifacts/test/lab-sweep-smart-baskets'),
			throughGate: 'G2'
		});

		const basketUnit = result.trace.units.find((unit) => unit.id === 'baskets');
		const accepted =
			basketUnit?.drawables.filter((drawable) => drawable.verdict === 'accepted') ?? [];
		const rejected =
			basketUnit?.drawables.filter((drawable) => drawable.verdict === 'rejected') ?? [];
		const semanticTips =
			basketUnit?.drawables.filter(
				(drawable) =>
					drawable.verdict === 'info' && drawable.ref?.endsWith(':semantic-tip')
			) ?? [];
		expect(accepted).toHaveLength(18);
		expect(rejected.length).toBeLessThanOrEqual(4);
		expect(semanticTips).toHaveLength(18);
		expect(
			accepted.every(
				(drawable) =>
					drawable.type === 'box' && drawable.bbox[2] === 46 && drawable.bbox[3] === 72
			)
		).toBe(true);
		expect(
			semanticTips.every((drawable) => drawable.values?.tipBelowBboxLastPixelPx === 2)
		).toBe(true);
		expect(
			accepted.some((drawable) => drawable.reason?.includes('accepted occlusion recovery'))
		).toBe(true);
		expect(result.trace.execution).toEqual(['badgeStage', 'badges', 'baskets']);
	}, 60_000);

	test('default G3 exposes the visible-tee deficit as an explicit recovery expectation', async () => {
		const result = await runSweepOperation({
			configPath: resolve(REPO_ROOT, 'packages/alg/src/detectors/threeFactor/configs/default.json'),
			inputPaths: [resolve(CORPUS_ROOT, 'dev/DashsTrack/DashsTrack-full.jpg')],
			outDir: resolve(REPO_ROOT, 'artifacts/test/lab-sweep-visible-tees'),
			throughGate: 'G3'
		});

		const badgeUnit = result.trace.units.find((unit) => unit.id === 'badges');
		const teeFamilyUnit = result.trace.units.find((unit) => unit.id === 'teeFamily');
		const teeFamilyRender = result.featureRenders.results.find(
			(render) => render.featureId === 'teeFamily' && render.unitId === 'teeFamily'
		);
		const detectedBadgeCount =
			badgeUnit?.drawables.filter((drawable) => drawable.verdict === 'accepted').length;
		const acceptedVisibleTeeCount =
			teeFamilyUnit?.drawables.filter((drawable) => drawable.verdict === 'accepted').length;
		const acceptedVisibleTeeBounds =
			teeFamilyUnit?.drawables.filter((drawable) => drawable.verdict === 'accepted') ?? [];
		const padAabbs =
			teeFamilyUnit?.drawables.filter((drawable) => drawable.ref?.endsWith(':pad-aabb')) ?? [];
		const ringInteriors =
			teeFamilyUnit?.drawables.filter((drawable) => drawable.ref?.endsWith(':ring-interior')) ?? [];

		expect(detectedBadgeCount).toBe(18);
		expect(acceptedVisibleTeeCount).toBe(16);
		expect(
			acceptedVisibleTeeBounds.every(
				(drawable) =>
					drawable.type === 'polyline' &&
					drawable.path.length === 5 &&
					drawable.path[0][0] === drawable.path[4][0] &&
					drawable.path[0][1] === drawable.path[4][1] &&
					typeof drawable.values?.frameAngleRad === 'number'
			)
		).toBe(true);
		expect(padAabbs).toHaveLength(16);
		expect(ringInteriors).toHaveLength(16);
		expect(teeFamilyUnit?.drawables.filter((drawable) => drawable.verdict === 'rejected')).toHaveLength(1);
		expect(result.trace.execution).toEqual([
			'badgeStage',
			'badges',
			'baskets',
			'tees',
			'teeFamily'
		]);
		expect(result.receipts.map((receipt) => receipt.opId)).not.toContain('tees.componentFallback');
		expect(teeFamilyRender?.acceptedCount).toBe(acceptedVisibleTeeCount);
		expect(teeFamilyRender?.receiptText).toContain('acceptedVisibleTeeCount: 16');
		expect(teeFamilyRender?.receiptText).toContain('detectedBadgeCount: 18');
		expect(teeFamilyRender?.receiptText).toContain(
			'accepted object geometry: closed oriented quadrilateral'
		);
		expect(teeFamilyRender?.receiptText).toContain(
			'expectedRecoverNum: 2  (math: max(0, detectedBadgeCount - acceptedVisibleTeeCount))'
		);
		expect(teeFamilyRender?.receiptText).toContain(
			'expectedRecoverNum is a cardinality-derived recovery expectation, not truth, localization, or ownership.'
		);
	}, 60_000);

	test('enabled features receive the resolved context and tee evidence renders from that same sweep trace', async () => {
		expect(g2SpriteFeature.render?.units).toEqual(['baskets']);
		const result = await runSweepOperation({
			configPath: resolve(
				REPO_ROOT,
				'packages/alg/src/detectors/threeFactor/configs/clean-basket-family-on.json'
			),
			inputPaths: [resolve(CORPUS_ROOT, 'dev/DashsTrack/DashsTrack-full.jpg')],
			outDir: resolve(REPO_ROOT, 'artifacts/test/lab-sweep-receipt')
		});

		expect(result.trace.paramsHash).toMatch(/^[0-9a-f]{64}$/);
		expect(result.trace.features.cleanBasketFamily.enabled).toBe(true);
		const cleanBasketReceipt = result.receipts.find(
			(receipt) => receipt.opId === 'cleanBasketFamily'
		);
		expect(cleanBasketReceipt?.actualConsumes).toContain('sprites');
		expect(cleanBasketReceipt?.actualProduces).toContain('baskets');

		const basketUnit = result.trace.units.find((unit) => unit.id === 'baskets');
		const basketRender = result.featureRenders.results.find(
			(render) => render.featureId === 'sprite' && render.unitId === 'baskets'
		);
		expect(basketUnit?.drawables.some((drawable) => drawable.verdict === 'accepted')).toBe(true);
		expect(basketUnit?.drawables.some((drawable) => drawable.verdict === 'rejected')).toBe(true);
		expect(basketRender?.acceptedCount).toBe(
			basketUnit?.drawables.filter((drawable) => drawable.verdict === 'accepted').length
		);
		expect(basketRender?.rejectedCount).toBe(
			basketUnit?.drawables.filter((drawable) => drawable.verdict === 'rejected').length
		);
		expect(basketRender?.filesWritten.every(existsSync)).toBe(true);
		expect(basketRender?.filesWritten.some((path) => path.endsWith('.bright-mask.png'))).toBe(true);
		expect(basketRender?.filesWritten.some((path) => path.endsWith('.dark-mask.png'))).toBe(true);
		expect(basketRender?.receiptText.match(/^  layer=/gm)?.length).toBe(
			basketRender?.drawableCount
		);

		const teeUnit = result.trace.units.find((unit) => unit.id === 'tees');
		const teeRender = result.featureRenders.results.find(
			(render) => render.featureId === 'endpoints' && render.unitId === 'tees'
		);
		expect(teeUnit?.drawables.some((drawable) => drawable.verdict === 'accepted')).toBe(true);
		expect(teeUnit?.drawables.some((drawable) => drawable.verdict === 'rejected')).toBe(true);
		expect(teeRender?.acceptedCount).toBe(
			teeUnit?.drawables.filter((drawable) => drawable.verdict === 'accepted').length
		);
		expect(teeRender?.rejectedCount).toBe(
			teeUnit?.drawables.filter((drawable) => drawable.verdict === 'rejected').length
		);
		expect(teeRender?.filesWritten.every(existsSync)).toBe(true);
		expect(teeRender?.receiptText.match(/^  layer=/gm)?.length).toBe(teeRender?.drawableCount);
		expect(teeRender?.receiptText).toContain('coordinate transform: canonical = original + (0,-4)');
	}, 60_000);
});

describe('truth receipt association', () => {
	test('grounding comparison separates semantic basket bounds from white detector bounds', () => {
		const board = createExecBoard();
		const basket = (detId: string, xPx: number, truthYPx: number): BasketEvidence => ({
			detId,
			bbox: [xPx - 25, truthYPx - 69, 50, 74],
			whiteBbox: [xPx - 21, truthYPx - 65, 42, 66],
			centerXPx: xPx,
			centerYPx: truthYPx - 32,
			tipXPx: xPx,
			tipYPx: truthYPx + 5,
			onFrac: 1,
			offFrac: 0,
			score: 1
		});
		board.set('baskets', [basket('b1', 10, 20), basket('b2', 40, 80)]);
		const truth: CanonicalTruth = {
			schemaVersion: 1,
			sourceImage: {
				fileName: 'synthetic.png',
				mimeType: 'image/png',
				widthPx: 100,
				heightPx: 100,
				sha256: 'synthetic',
				bundlePath: 'synthetic.png'
			},
			holes: [
				{ id: 'h1', number: 1, shots: [], corridorBends: [], corridorWidthPx: 1, tee: { xPx: 0, yPx: 0 }, basket: { xPx: 10, yPx: 20 } },
				{ id: 'h2', number: 2, shots: [], corridorBends: [], corridorWidthPx: 1, tee: { xPx: 0, yPx: 0 }, basket: { xPx: 40, yPx: 80 } }
			]
		};

		const [comparison] = compareTruthGrounding(board, truth, { xPx: 0, yPx: -4 }, true);
		const ranked = [...comparison.hypotheses].sort(
			(a, b) => a.medianDeviationPx - b.medianDeviationPx
		);
		expect(ranked[0]).toMatchObject({
			id: 'white-box-last-pixel',
			yShiftPx: -5,
			matchedWithinTolerance: 2,
			falsePositiveCount: 0,
			falseNegativeCount: 0,
			medianDeviationPx: 0
		});
		expect(
			ranked.find((candidate) => candidate.id.includes('as-emitted'))?.medianDeviationPx
		).toBe(5);
	});

	test('one detection cannot satisfy two truth objects and unmatched detections stay visible', () => {
		const targets: TruthTarget[] = [
			{ identity: 'H1', point: { xPx: 0, yPx: 0 } },
			{ identity: 'H2', point: { xPx: 10, yPx: 0 } }
		];
		const detections: LocatedDetection[] = [
			{
				id: 'tee-one',
				spriteType: 'tee',
				identity: 'tee-one:ring',
				xPx: 5,
				yPx: 0,
				measurements: { tier: 'ring' }
			},
			{
				id: 'tee-extra',
				spriteType: 'tee',
				identity: 'tee-extra:ring',
				xPx: 100,
				yPx: 100,
				measurements: { tier: 'ring' }
			}
		];

		const result = associateDetections(targets, detections, { xPx: 0, yPx: -4 });
		expect(result.matched).toBe(1);
		expect(result.misses).toEqual(['H2:no unclaimed detection within 26px']);
		expect(result.unownedDetections?.map((detection) => detection.id)).toEqual(['tee-extra']);
		expect(result.objectMatches?.[0]?.detectionOriginal).toEqual({ xPx: 5, yPx: 4 });
	});
});
