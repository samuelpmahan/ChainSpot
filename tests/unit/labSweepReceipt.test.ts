import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { PNG } from 'pngjs';
import { createExecBoard } from '@chainspot/alg/exec';
import type { CanonicalTruth } from '@chainspot/alg/g0/truth';
import type { BasketEvidence } from '@chainspot/alg/detectors/threeFactor/types';
import { g2SpriteFeature } from '@chainspot/alg/detectors/threeFactor/features/g2.sprite';
import {
	compileSweepConfig,
	decideTruthScoring,
	runSweepOperation,
	slicePlanThroughGate
} from '../../scripts/chainspot-lab/sweep/operation';
import type { G0Report } from '../../scripts/chainspot-lab/sweep/inputShim';
import {
	canonicalizeInputs,
	normalizeTruthMatchForInputCount
} from '../../scripts/chainspot-lab/sweep/inputShim';
import {
	associateDetections,
	compareTruthGrounding,
	type LocatedDetection,
	type TruthTarget
} from '../../scripts/chainspot-lab/sweep/truthScoring';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const CORPUS_ROOT = resolve(REPO_ROOT, '../chainspot-corpus');

function emptyTruth(): CanonicalTruth {
	return {
		schemaVersion: 1,
		sourceImage: {
			fileName: 'synthetic.png',
			mimeType: 'image/png',
			widthPx: 100,
			heightPx: 100,
			sha256: 'synthetic',
			bundlePath: 'synthetic.png'
		},
		holes: []
	};
}

function truthWithOneHole(widthPx: number, heightPx: number): CanonicalTruth {
	const base = emptyTruth();
	return {
		...base,
		sourceImage: {
			...base.sourceImage,
			widthPx,
			heightPx
		},
		holes: [
			{
				id: 'hole-1',
				number: 1,
				shots: [],
				corridorBends: [],
				corridorWidthPx: 37,
				tee: { xPx: 5, yPx: 5 },
				basket: { xPx: 10, yPx: 10 }
			}
		]
	};
}

function writeWorldTile(path: string, originX: number, originY: number): void {
	const png = new PNG({ width: 32, height: 28 });
	for (let y = 0; y < png.height; y++) {
		for (let x = 0; x < png.width; x++) {
			const value =
				(((originX + x) * 73) ^ ((originY + y) * 151) ^ ((originX + x) * (originY + y) * 29)) & 255;
			const index = (y * png.width + x) * 4;
			png.data[index] = value;
			png.data[index + 1] = value;
			png.data[index + 2] = value;
			png.data[index + 3] = 255;
		}
	}
	writeFileSync(path, PNG.sync.write(png));
}

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

	test('later gate names are vocabulary, not executable cutoff promises', async () => {
		const { plan } = compileSweepConfig(
			resolve(REPO_ROOT, 'packages/alg/src/detectors/threeFactor/configs/default.json')
		);
		await expect(slicePlanThroughGate(plan, 'G4' as never)).rejects.toThrow(
			/only dependency-complete cutoffs G1, G2, or G3/
		);
	});

	test('G3 slices exclude the post-assignment tee recovery and terminal phantom completion', async () => {
		const { plan } = compileSweepConfig(
			resolve(
				REPO_ROOT,
				'packages/alg/src/detectors/threeFactor/configs/tee-recovery-phantom-on.json'
			)
		);
		const sliced = await slicePlanThroughGate(plan, 'G3');
		expect(sliced.ops.map((operation) => operation.id)).not.toContain('teeRecovery');
		expect(sliced.ops.map((operation) => operation.id)).not.toContain('phantomTee');
		expect(sliced.ops.every((operation) => operation.gate !== 'G4')).toBe(true);
	});

	test('multi-input unverified truth is skipped end-to-end with an exact reason', async () => {
		const root = mkdtempSync(join(tmpdir(), 'lab-sweep-truth-'));
		try {
			const left = join(root, 'left.png');
			const right = join(root, 'right.png');
			const truthPath = join(root, 'truth.json');
			writeWorldTile(left, 100, 100);
			writeWorldTile(right, 109, 94);
			const canonical = await canonicalizeInputs([left, right]);
			writeFileSync(
				truthPath,
				JSON.stringify(truthWithOneHole(canonical.report.widthPx, canonical.report.heightPx))
			);

			const result = await runSweepOperation({
				configPath: resolve(
					REPO_ROOT,
					'packages/alg/src/detectors/threeFactor/configs/default.json'
				),
				inputPaths: [left, right],
				truthPath,
				outDir: join(root, 'out'),
				throughGate: 'G1'
			});

			expect(result.report.truthMatch).toMatchObject({ level: 'dims-only' });
			expect(result.truthScoringSkipped).toBe(true);
			expect(result.truthScoringReason).toContain(
				'Dimensions-only truth correspondence is unverified'
			);
			expect(result.scoreboard).toBeUndefined();
			expect(result.groundingComparisons).toEqual([]);
			expect(result.runReceiptPaths).toHaveLength(2);
			expect(result.runReceiptPaths.every(existsSync)).toBe(true);
			const persisted = JSON.parse(readFileSync(result.runReceiptPaths[0], 'utf8'));
			expect(persisted.schema).toBe('chainspot-lab-run-receipt@1');
			expect(persisted.operations.map((operation: { id: string }) => operation.id)).toEqual(
				result.receipts.map((receipt) => receipt.opId)
			);
			// The inventory now names every render file the run wrote: the exact
			// canonical raster, one entry per artifact render (rendered or stub,
			// truthfully), and the endpoint feature receipt.
			expect(persisted.visualRenders[0]).toMatchObject({
				kind: 'canonical',
				gate: 'G0',
				id: 'g0.canonical',
				status: 'rendered'
			});
			const featureRenders = persisted.visualRenders.filter(
				(render: { kind: string }) => render.kind === 'feature'
			);
			expect(featureRenders).toHaveLength(1);
			expect(featureRenders[0]).toMatchObject({
				gate: 'G0-G1',
				id: 'run.endpoint-summary',
				status: 'rendered'
			});
			expect(
				persisted.visualRenders
					.flatMap((render: { files: string[] }) => render.files)
					.every((file: string) => !isAbsolute(file) && existsSync(resolve(result.outDir, file)))
			).toBe(true);
			expect(readFileSync(result.runReceiptPaths[1], 'utf8')).toContain(
				'OPERATIONS (CHRONOLOGICAL)'
			);
			expect(readFileSync(result.runReceiptPaths[1], 'utf8')).toContain('VISUAL RENDERS');

			// Conformance: the human text restates the machine receipt exactly.
			const text = readFileSync(result.runReceiptPaths[1], 'utf8');
			for (const name of [
				'badges',
				'baskets',
				'visibleTees',
				'recoveredTees',
				'phantomTees',
				'totalTees',
				'assignments',
				'rawPairs'
			] as const) {
				const line = text.split('\n').find((row) => row.startsWith(`results.${name}: `));
				expect(line, `missing results.${name} line`).toBeTruthy();
				const printed = line!.slice(`results.${name}: `.length).split('  (')[0];
				const machine = persisted.results[name];
				expect(printed).toBe(machine === undefined || machine === null ? 'UNKNOWN' : String(machine));
				// Every FINAL RESULTS line carries provenance or a reasoned absence.
				expect(persisted.resultsProvenance[name], `no provenance for results.${name}`).toBeTruthy();
				expect(line).toContain(`(${persisted.resultsProvenance[name]}`);
			}
			// Conformance: per-unit rejected count equals the sum of its reason lines.
			for (const unitReceipt of persisted.units) {
				const reasonSum = unitReceipt.rejectionReasons.reduce(
					(sum: number, reason: { count: number }) => sum + reason.count,
					0
				);
				expect(unitReceipt.rejected).toBe(reasonSum);
			}
			// Conformance: the VISUAL RENDERS inventory names exactly the render
			// files on disk — nothing silently absent, nothing claimed but missing.
			const inventoried = persisted.visualRenders
				.flatMap((render: { files: string[] }) => render.files)
				.sort();
			const walk = (dir: string): string[] =>
				readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
					entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]
				);
			const onDisk = walk(join(result.outDir, 'renders'))
				.map((path) => relative(result.outDir, path).split('\\').join('/'))
				.sort();
			expect(inventoried).toEqual(onDisk);
			// Conformance: rendered/stub statuses are truthful — a stub entry's
			// files are stub notes, a rendered entry's files are real renders.
			for (const render of persisted.visualRenders) {
				if (render.kind !== 'artifact') continue;
				const allStubs = render.files.every((file: string) => file.endsWith('.stub.txt'));
				expect(render.status).toBe(allStubs ? 'stub' : 'rendered');
			}
			// No truth was scorable here, and the receipt says why instead of
			// leaving a bare UNKNOWN.
			expect(text).toContain('evaluation.reason: Dimensions-only truth correspondence');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
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
				(drawable) => drawable.verdict === 'info' && drawable.ref?.endsWith(':semantic-tip')
			) ?? [];
		expect(accepted).toHaveLength(18);
		expect(rejected.length).toBeLessThanOrEqual(4);
		expect(semanticTips).toHaveLength(18);
		expect(
			accepted.every(
				(drawable) => drawable.type === 'box' && drawable.bbox[2] === 46 && drawable.bbox[3] === 72
			)
		).toBe(true);
		expect(semanticTips.every((drawable) => drawable.values?.tipBelowBboxLastPixelPx === 2)).toBe(
			true
		);
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
		const basketUnit = result.trace.units.find((unit) => unit.id === 'baskets');
		const teeUnit = result.trace.units.find((unit) => unit.id === 'tees');
		const endpointRender = result.featureRenders.results[0];
		const detectedBadgeCount = badgeUnit?.drawables.filter(
			(drawable) => drawable.verdict === 'accepted'
		).length;
		const acceptedVisibleTeeCount = teeFamilyUnit?.drawables.filter(
			(drawable) => drawable.verdict === 'accepted'
		).length;
		const acceptedVisibleTeeBounds =
			teeFamilyUnit?.drawables.filter((drawable) => drawable.verdict === 'accepted') ?? [];
		const padAabbs =
			teeFamilyUnit?.drawables.filter((drawable) => drawable.ref?.endsWith(':pad-aabb')) ?? [];
		const ringInteriors =
			teeFamilyUnit?.drawables.filter((drawable) => drawable.ref?.endsWith(':ring-interior')) ?? [];

		expect(detectedBadgeCount).toBe(18);
		expect(acceptedVisibleTeeCount).toBe(16);
		expect(basketUnit).toMatchObject({ featureId: 'sprite' });
		expect(basketUnit?.featureIds).toContain('sprite');
		expect(teeUnit).toMatchObject({ featureId: 'endpoints' });
		expect(teeUnit?.featureIds).toContain('endpoints');
		expect(teeUnit?.knobs).toEqual(result.trace.features.endpoints.knobs);
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
		expect(
			teeFamilyUnit?.drawables.filter((drawable) => drawable.verdict === 'rejected')
		).toHaveLength(1);
		expect(result.trace.execution).toEqual([
			'badgeStage',
			'badges',
			'baskets',
			'tees',
			'teeFamily'
		]);
		expect(result.receipts.map((receipt) => receipt.opId)).not.toContain('tees.componentFallback');
		expect(result.featureRenders.results).toHaveLength(1);
		expect(endpointRender?.receiptText).toContain('badges: 18');
		expect(endpointRender?.receiptText).toContain('basketSemanticTips: 18');
		expect(endpointRender?.receiptText).toContain('visibleTeeBorders: 16');
		expect(endpointRender?.receiptText).toContain(
			'expectedRecoverNum: 2 (math: max(0, badges - visibleTeeBorders))'
		);
		const teeVisualReceipt = result.runReceipt.visualRenders.find(
			(render) => render.kind === 'feature' && render.id === 'run.endpoint-summary'
		);
		expect(teeVisualReceipt).toMatchObject({ gate: 'G0-G3', status: 'rendered' });
		expect(teeVisualReceipt?.files).toHaveLength(2);
		expect(teeVisualReceipt?.files.some((path) => path.endsWith('.png'))).toBe(true);
		expect(teeVisualReceipt?.files.some((path) => path.endsWith('.receipt.txt'))).toBe(true);

		// Receipt truth for the slice: G4 recovery never ran, so the receipt must
		// not claim "ran and found 0". The number is absent WITH a stated reason.
		expect(result.runReceipt.results.recoveredTees).toBeUndefined();
		expect(result.runReceipt.results.totalTees).toBeUndefined();
		expect(result.runReceipt.resultsProvenance.recoveredTees).toContain('not-scheduled');
		expect(result.runReceipt.resultsProvenance.totalTees).toContain('not-computable');
		expect(result.runReceipt.resultsProvenance.totalTees).toContain('visible tees alone = 16');
		const g3Text = readFileSync(
			resolve(result.outDir, 'run.receipt.txt'),
			'utf8'
		);
		expect(g3Text).toMatch(/results\.recoveredTees: UNKNOWN {2}\(not-scheduled:/);
		expect(g3Text).not.toContain('results.recoveredTees: 0');
		// The visual receipt draws the same line between "never ran" and "0".
		const g3Visual = readFileSync(
			resolve(result.outDir, 'renders/run/run.visual.receipt.txt'),
			'utf8'
		);
		expect(g3Visual).toContain('recoveredTeePoses: NOT-SCHEDULED');
		expect(g3Visual).toContain("G4 teeRecovery: NOT-SCHEDULED");
		expect(g3Visual).toContain("G4 phantomTee: NOT-SCHEDULED");
		expect(g3Visual).not.toMatch(/recoveredTeePoses: \d/);
		expect(teeVisualReceipt?.summary).toContain('recovery not-scheduled');
	}, 60_000);

	test('enabled features receive the resolved context and tee evidence renders from that same sweep trace', async () => {
		expect(g2SpriteFeature.render?.units).toEqual(['baskets']);
		const result = await runSweepOperation({
			configPath: resolve(REPO_ROOT, 'tests/fixtures/lab-sweep-custom-g5.json'),
			inputPaths: [resolve(CORPUS_ROOT, 'dev/DashsTrack/DashsTrack-full.jpg')],
			outDir: resolve(REPO_ROOT, 'artifacts/test/lab-sweep-receipt')
		});

		expect(result.trace.paramsHash).toMatch(/^[0-9a-f]{64}$/);
		expect(result.trace.features.cleanBasketFamily.enabled).toBe(true);
		expect(result.trace.features.zfit.enabled).toBe(true);
		expect(result.measurement?.parameters).toMatchObject({
			zfit: true,
			fieldScale: 4,
			supportTau: 0.6,
			corridorWidthPx: 41,
			orientations: 10,
			widthsSrc: [20, 28, 36, 44],
			alignmentPower: 3,
			worstWindowSrcPx: 84
		});
		const cleanBasketReceipt = result.receipts.find(
			(receipt) => receipt.opId === 'cleanBasketFamily'
		);
		expect(cleanBasketReceipt?.actualConsumes).toContain('sprites');
		expect(cleanBasketReceipt?.actualProduces).toContain('baskets');

		const basketUnit = result.trace.units.find((unit) => unit.id === 'baskets');
		const endpointRender = result.featureRenders.results[0];
		expect(basketUnit?.drawables.some((drawable) => drawable.verdict === 'accepted')).toBe(true);
		expect(basketUnit?.drawables.some((drawable) => drawable.verdict === 'rejected')).toBe(true);

		const teeUnit = result.trace.units.find((unit) => unit.id === 'tees');
		expect(teeUnit?.drawables.some((drawable) => drawable.verdict === 'accepted')).toBe(true);
		expect(teeUnit?.drawables.some((drawable) => drawable.verdict === 'rejected')).toBe(true);
		expect(result.featureRenders.results).toHaveLength(1);
		expect(endpointRender?.filesWritten).toHaveLength(2);
		expect(endpointRender?.filesWritten.every(existsSync)).toBe(true);
		expect(endpointRender?.receiptText).toContain('basketSemanticTips: 18');
		expect(endpointRender?.receiptText).toContain('visibleTeeBorders: 16');
		expect(endpointRender?.receiptText).toContain(
			'coordinateTransform: canonical = original + (0,-4)'
		);
	}, 60_000);
});

describe('truth receipt association', () => {
	test('unmatched truth cannot materialize canonical grounding evidence', async () => {
		const decoded = await canonicalizeInputs(
			[resolve(CORPUS_ROOT, 'dev/DashsTrack/DashsTrack-full.jpg')],
			emptyTruth()
		);
		expect(decoded.report.truthMatch).toBeNull();
		expect(decoded.canonicalTruth).toBeUndefined();
	});

	test('multi-input reconciliation is downgraded while an exact composite match is retained', () => {
		expect(normalizeTruthMatchForInputCount(2, { level: 'reconciled-verified' })).toMatchObject({
			level: 'dims-only',
			warning: expect.stringContaining('Multiple source placements')
		});
		expect(
			normalizeTruthMatchForInputCount(2, {
				level: 'byte',
				matchedAgainst: 'canonical'
			})
		).toEqual({ level: 'byte', matchedAgainst: 'canonical' });
	});

	test('only verified canonical-frame truth can produce an official scoreboard', () => {
		const truth = emptyTruth();
		const report = (truthMatch: G0Report['truthMatch']) => ({ truthMatch }) as G0Report;

		expect(
			decideTruthScoring(report({ level: 'byte', matchedAgainst: 'canonical' }), truth)
		).toEqual({ eligible: true, provenanceTrusted: true });

		expect(decideTruthScoring(report({ level: 'dims-only' }), truth)).toMatchObject({
			eligible: false,
			provenanceTrusted: false,
			reason: expect.stringContaining('unverified')
		});

		expect(decideTruthScoring(report({ level: 'reconciled-verified' }), undefined)).toMatchObject({
			eligible: false,
			provenanceTrusted: false,
			reason: expect.stringContaining('not mapped')
		});
	});

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
				{
					id: 'h1',
					number: 1,
					shots: [],
					corridorBends: [],
					corridorWidthPx: 1,
					tee: { xPx: 0, yPx: 0 },
					basket: { xPx: 10, yPx: 20 }
				},
				{
					id: 'h2',
					number: 2,
					shots: [],
					corridorBends: [],
					corridorWidthPx: 1,
					tee: { xPx: 0, yPx: 0 },
					basket: { xPx: 40, yPx: 80 }
				}
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
		expect(ranked.find((candidate) => candidate.id.includes('as-emitted'))?.medianDeviationPx).toBe(
			5
		);
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
