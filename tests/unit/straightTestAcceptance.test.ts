import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
	compileABFeatureSet,
	compileExecutionPlan,
	createExecBoard,
	executeABFeatureSet,
	executeCompiledPlan
} from '@chainspot/alg/exec';
import {
	DEFAULT_EXECUTION,
	GATE_FEATURE_SETS,
	parseConfig,
	resolveConfig,
	runThreeFactor,
	type ThreeFactorConfig
} from '@chainspot/alg/detectors/threeFactor';
import { seedBoard } from '@chainspot/alg/detectors/threeFactor/measure';
import {
	nullFeatureContext,
	type ABFeature,
	type EvidenceBoard
} from '@chainspot/alg/detectors/threeFactor/features/types';
import {
	STRAIGHT_TEST_FEATURE_ID,
	STRAIGHT_TEST_COORDINATE_FRAME,
	type StraightTestCandidateInput,
	type StraightTestTrace,
	type StraightTestTruthAssistance
} from '@chainspot/alg/detectors/threeFactor/features/st.straightTest.contract';
import {
	evaluateStraightTestCandidate,
	measureStraightGeometry,
	straightTestFeature,
	straightTestUnit
} from '@chainspot/alg/detectors/threeFactor/features/st.straightTest';
import defaultConfig from '@chainspot/alg/detectors/threeFactor/configs/default.json';
import straightOn from '@chainspot/alg/detectors/threeFactor/configs/straight-test-on.json';
import straightTruthCompare from '@chainspot/alg/detectors/threeFactor/configs/straight-test-truth-assisted-compare.json';
import {
	makeTraceRunId,
	sealTrace
} from '@chainspot/alg/detectors/threeFactor/features/traceIdentity';
import { runSweepOperation } from '../../scripts/chainspot-lab/sweep/operation';

const REPO_ROOT = resolve(__dirname, '../..');
const CORPUS_ROOT = resolve(REPO_ROOT, '../chainspot-corpus');
const DASHS_IMAGE = resolve(CORPUS_ROOT, 'dev/DashsTrack/DashsTrack-full.jpg');
const DASHS_TRUTH = resolve(CORPUS_ROOT, 'dev/DashsTrack/DashsTrack-full.annotation.json');
// 2026-08-28: zfit dropped from the default schedule by owner directive; the
// previous byte hash was
// 9762044ddfa243010466da423ade733e7902b1877620b40e1581cd904b45ae5b.
const DEFAULT_SHA256 = '71d88bc2bf44b4a1a10934636acda61aa8fb7563cf6417dc1ae4c7f36a3e1c45';

function candidate(
	overrides: Partial<StraightTestCandidateInput> = {}
): StraightTestCandidateInput {
	return {
		holeLabel: '1',
		badge: {
			detId: 'badge-1',
			xPx: 3,
			yPx: 4,
			label: '1',
			provenance: 'bright-family; identified badge'
		},
		tee: {
			detId: 'tee-1',
			xPx: 0,
			yPx: 0,
			tier: 'ring',
			angleRad: 0,
			provenance: 'ring; intact visible pad'
		},
		basket: {
			detId: 'basket-1',
			xPx: 10,
			yPx: 0,
			strongIdentity: true,
			provenance: 'clean-family; high renderer identity'
		},
		...overrides
	};
}

const blind: StraightTestTruthAssistance = { mode: 'blind', locks: [] };

function tinyRaster() {
	const widthPx = 48;
	const heightPx = 64;
	const rgba = new Uint8ClampedArray(widthPx * heightPx * 4);
	for (let index = 0; index < rgba.length; index += 4) {
		rgba[index] = rgba[index + 1] = rgba[index + 2] = 120;
		rgba[index + 3] = 255;
	}
	return { imageId: 's'.repeat(64), widthPx, heightPx, rgba };
}

describe('straightTest public ABFeature and pure geometry contract', () => {
	test('exports exactly the default-OFF truth-assistance switch, never a tuned threshold', () => {
		expect(straightTestFeature).toMatchObject({
			id: STRAIGHT_TEST_FEATURE_ID,
			gate: 'G5',
			kind: 'deviation',
			defaultEnabled: false
		});
		expect(Object.keys(straightTestFeature.knobs)).toEqual(['truthAssisted']);
		expect(straightTestFeature.knobs.truthAssisted.default).toBe(false);
	});

	test('measures the prescribed source-image-pixel equations exactly and keeps axial/directional angles distinct', () => {
		const measured = measureStraightGeometry(candidate());
		expect(measured.f).toBeCloseTo(0.3, 12);
		expect(measured.dPerpPx).toBeCloseTo(4, 12);
		expect(measured.axialResidualDeg).toBeCloseTo(53.1301023542, 9);
		expect(measured.directionalResidualDeg).toBeCloseTo(53.1301023542, 9);
		expect(measured.collinearityResidualDeg).toBeCloseTo(53.1301023542, 9);

		const reverseBadge = measureStraightGeometry(
			candidate({
				badge: { ...candidate().badge, xPx: -3, yPx: 0 },
				tee: { ...candidate().tee!, angleRad: Math.PI }
			})
		);
		// π and 0 are the same tee AXIS, but a badge behind the tee remains a
		// 180-degree directional/collinearity residual against tee→basket.
		expect(reverseBadge.axialResidualDeg).toBeCloseTo(0, 12);
		expect(reverseBadge.directionalResidualDeg).toBeCloseTo(180, 12);
		expect(reverseBadge.collinearityResidualDeg).toBeCloseTo(180, 12);
	});

	test('preserves missing/degenerate evidence as UNKNOWN and is deterministic', () => {
		const missingAxis = measureStraightGeometry(
			candidate({ tee: { ...candidate().tee!, angleRad: null } })
		);
		expect(missingAxis.axialResidualDeg).toBeNull();
		expect(missingAxis.f).toBeCloseTo(0.3, 12);

		const degenerate = measureStraightGeometry(
			candidate({ basket: { ...candidate().basket!, xPx: 0, yPx: 0 } })
		);
		expect(degenerate).toEqual({
			f: null,
			dPerpPx: null,
			axialResidualDeg: null,
			directionalResidualDeg: null,
			collinearityResidualDeg: null
		});
		expect(measureStraightGeometry(candidate())).toEqual(measureStraightGeometry(candidate()));
		expect(measureStraightGeometry(candidate({ tee: null }))).toEqual({
			f: null,
			dPerpPx: null,
			axialResidualDeg: null,
			directionalResidualDeg: null,
			collinearityResidualDeg: null
		});
	});

	test('uses existing semantic gates but abstains in blind mode because scoring sigmas are not hard thresholds', () => {
		const proposal = evaluateStraightTestCandidate(candidate(), blind);
		expect(proposal.coordinateFrame).toBe(STRAIGHT_TEST_COORDINATE_FRAME);
		expect(proposal.verdict).toBe('ABSTAIN');
		expect(proposal.selected).toBe(false);
		expect(proposal.gates).toMatchObject({
			identifiedBadge: 'PASS',
			strongBasketIdentity: 'PASS',
			semanticStrongRingTee: 'PASS',
			teeAxisToBadgeAgreement: 'UNKNOWN',
			badgeLongitudinalFraction: 'UNKNOWN',
			teeBadgeBasketCollinearity: 'UNKNOWN',
			oneToOneUniqueness: 'UNKNOWN'
		});
		expect(proposal.reasons.join('\n')).toMatch(/soft|sigma|UNKNOWN/i);
	});

	test('canonical endpoint locks retain their verified coordinates only in loudly tainted S0 geometry', () => {
		const assisted: StraightTestTruthAssistance = {
			mode: 'verified-canonical',
			taint: 'TRUTH-TAINT',
			provenance: 'verified canonical truth match',
			locks: [
				{
					holeNumber: 1,
					badgeId: 'badge-1',
					teeId: 'tee-1',
					basketId: 'basket-1',
					teeReference: 'detector',
					basketReference: 'detector',
					canonicalTee: {
						xPx: 0,
						yPx: 0,
						provenance: 'canonical-annotation-tee'
					},
					canonicalBasket: {
						xPx: 10,
						yPx: 0,
						provenance: 'canonical-annotation-basket'
					},
					provenance: 'canonical-annotation-endpoint-lock'
				}
			]
		};
		const detectorEvidence = candidate({
			tee: { ...candidate().tee!, xPx: 20, yPx: 20 },
			basket: { ...candidate().basket!, xPx: 40, yPx: 20 }
		});
		const proposal = evaluateStraightTestCandidate(detectorEvidence, assisted);
		expect(proposal).toMatchObject({
			verdict: 'PROVISIONAL',
			selected: true,
			truthTainted: true,
			badgeId: 'badge-1',
			teeId: 'tee-1',
			basketId: 'basket-1',
			runnerUpProposalId: null
		});
		// S0 records the coordinates it measured, while detector evidence is
		// merely read and remains unchanged outside this tainted comparison seam.
		expect(proposal.geometryEndpoints).toMatchObject({
			badge: { xPx: 3, yPx: 4 },
			tee: {
				xPx: 0,
				yPx: 0,
				provenance: 'canonical-annotation-tee',
				axisAngleRad: 0
			},
			basket: { xPx: 10, yPx: 0, provenance: 'canonical-annotation-basket' }
		});
		expect(proposal.measurements).toMatchObject({ f: 0.3, dPerpPx: 4 });
		expect(detectorEvidence.tee).toMatchObject({ xPx: 20, yPx: 20 });
		expect(detectorEvidence.basket).toMatchObject({ xPx: 40, yPx: 20 });
		expect(proposal.reasons.join('\n')).toMatch(/TRUTH-TAINT|not.*ownership|not.*bend/i);
	});

	test('assisted comparison may retain an annotation-only tee ref when G3 has no visible tee', () => {
		const assisted: StraightTestTruthAssistance = {
			mode: 'verified-canonical',
			taint: 'TRUTH-TAINT',
			provenance: 'verified canonical truth match',
			locks: [
				{
					holeNumber: 3,
					badgeId: 'badge-1',
					teeId: 'truth:H3:tee',
					basketId: 'basket-1',
					teeReference: 'canonical-annotation',
					basketReference: 'detector',
					canonicalTee: { xPx: 0, yPx: 0, provenance: 'canonical-annotation-tee' },
					canonicalBasket: { xPx: 10, yPx: 0, provenance: 'canonical-annotation-basket' },
					provenance: 'canonical-annotation-endpoint-lock'
				}
			]
		};
		const proposal = evaluateStraightTestCandidate(candidate({ tee: null }), assisted);
		expect(proposal.teeId).toBe('truth:H3:tee');
		expect(proposal.truthTainted).toBe(true);
		expect(proposal.geometryEndpoints?.tee).toMatchObject({
			xPx: 0,
			yPx: 0,
			provenance: 'canonical-annotation-tee',
			axisAngleRad: null
		});
		expect(proposal.reasons.join('\n')).toMatch(/canonical|TRUTH-TAINT/i);
	});

	test('a verified comparison emits tainted ABSTAIN rather than throwing when an identified badge has no lock', () => {
		const board = createExecBoard();
		board.set('badges', [{ detId: 'badge-unlocked', cxPx: 3, cyPx: 4, label: '2' }]);
		board.set('tees', []);
		board.set('baskets', []);
		board.set('straightTestTruthAssistance', {
			mode: 'verified-canonical',
			taint: 'TRUTH-TAINT',
			locks: [
				{
					holeNumber: 1,
					badgeId: 'different-badge',
					teeId: 'truth:H1:tee',
					basketId: 'truth:H1:basket',
					teeReference: 'canonical-annotation',
					basketReference: 'canonical-annotation',
					canonicalTee: { xPx: 0, yPx: 0, provenance: 'canonical-annotation-tee' },
					canonicalBasket: { xPx: 10, yPx: 0, provenance: 'canonical-annotation-basket' },
					provenance: 'canonical-annotation-endpoint-lock'
				}
			]
		} satisfies StraightTestTruthAssistance);
		let recorded: StraightTestTrace | undefined;
		const ctx = {
			...nullFeatureContext,
			resolve: () => ({ enabled: true, knobs: { truthAssisted: true } }),
			recordStraightTest: (trace: StraightTestTrace) => {
				recorded = trace;
			}
		};
		expect(() => straightTestUnit.run(board as unknown as EvidenceBoard, ctx)).not.toThrow();
		expect(recorded?.proposals).toHaveLength(1);
		expect(recorded?.proposals[0]).toMatchObject({
			verdict: 'ABSTAIN',
			truthTainted: true,
			teeId: null,
			basketId: null,
			candidateCount: 0,
			geometryEndpoints: null
		});
		expect(recorded?.proposals[0]?.reasons.join('\n')).toMatch(
			/TRUTH-TAINT|no verified canonical lock/i
		);
	});
});

describe('straightTest production composition and frozen-off parity', () => {
	test('keeps default.json byte-identical and default execution/off output unchanged', () => {
		const defaultPath = resolve(
			REPO_ROOT,
			'packages/alg/src/detectors/threeFactor/configs/default.json'
		);
		expect(createHash('sha256').update(readFileSync(defaultPath)).digest('hex')).toBe(
			DEFAULT_SHA256
		);

		const raster = tinyRaster();
		const bare = runThreeFactor(raster);
		const resolved = resolveConfig(defaultConfig as ThreeFactorConfig, DEFAULT_EXECUTION);
		// The new default-OFF feature is deliberately absent from the frozen
		// resolved baseline hash; FeatureContext still falls back to OFF.
		expect(resolved.features.straightTest).toBeUndefined();
		expect(resolved.execution).not.toContain('straightTest');
		const configured = runThreeFactor(raster, { config: resolved, paramsHash: 'default-off' });
		expect(configured.measurement).toEqual(bare.measurement);
		expect(configured.assignment).toEqual(bare.assignment);
		expect(configured.trace?.units.map((unit) => unit.id)).not.toContain('straightTest');
	});

	test('places the public feature and its production operation before support/ribbon work, then executes through the ABFeatureSet gateway', async () => {
		const set = GATE_FEATURE_SETS['g5-set'];
		expect(set.features.map((feature) => feature.id)).toEqual([
			'fourLaneSensor',
			'straightTest',
			'ribbon',
			'routing'
		]);
		const compiled = compileABFeatureSet(set, { straightTest: { enabled: true } });
		expect(compiled.enabledFeatureIds).toContain(STRAIGHT_TEST_FEATURE_ID);
		expect(compiled.plan.ops.map((operation) => operation.id)).toEqual([
			'straightTest',
			'supportField',
			'badgeOcclusionPatch',
			'rawPairs',
			'measurement'
		]);

		const resolved = resolveConfig(defaultConfig as ThreeFactorConfig, DEFAULT_EXECUTION);
		const board = createExecBoard();
		seedBoard(
			board as unknown as EvidenceBoard,
			{
				width: 48,
				height: 64,
				data: tinyRaster().rgba
			},
			undefined
		);
		board.set('recoveredTees', []);
		board.set('straightTestTruthAssistance', blind);
		executeCompiledPlan(compileExecutionPlan(resolved), board, nullFeatureContext);
		let recorded: StraightTestTrace | undefined;
		const gatewayContext = {
			...nullFeatureContext,
			resolve(feature: ABFeature) {
				return compiled.plan.bindings[feature.id] ?? nullFeatureContext.resolve(feature);
			},
			recordStraightTest(trace: StraightTestTrace) {
				recorded = trace;
			}
		};
		const receipt = await executeABFeatureSet(compiled, board, gatewayContext, {
			runId: 'straight-test-g5-set',
			invocation: 'straightTestAcceptance'
		});
		expect(receipt.operations.map((operation) => operation.opId)).toEqual(
			compiled.plan.ops.map((operation) => operation.id)
		);
		expect(receipt.operations[0]?.declaredProduces).toContain('straightProposals');
		expect(recorded?.featureId).toBe(STRAIGHT_TEST_FEATURE_ID);
		expect(board.get('straightProposals')).toEqual(recorded?.proposals);
	});

	test('regular ON creates early blind abstention testimony without changing ownership, while a truth-assisted config cannot run without verified locks', () => {
		const raster = tinyRaster();
		const baseline = runThreeFactor(raster);
		const onResolved = resolveConfig(parseConfig(straightOn), DEFAULT_EXECUTION);
		const expectedExecution = [...(defaultConfig as ThreeFactorConfig).execution!];
		expectedExecution.splice(expectedExecution.indexOf('teeFamily') + 1, 0, 'straightTest');
		expect(onResolved.execution).toEqual(expectedExecution);
		expect(onResolved.execution.indexOf('straightTest')).toBeLessThan(
			onResolved.execution.indexOf('supportField')
		);
		const on = runThreeFactor(raster, { config: onResolved, paramsHash: 'straight-on' });
		expect(on.assignment).toEqual(baseline.assignment);
		expect(on.trace?.units.map((unit) => unit.id)).toContain('straightTest');
		expect(on.trace?.straightTest?.truthAssistance.mode).toBe('blind');

		const tainted = resolveConfig(parseConfig(straightTruthCompare), DEFAULT_EXECUTION);
		expect(tainted.execution).toEqual(expectedExecution);
		expect(() =>
			runThreeFactor(raster, { config: tainted, paramsHash: 'must-refuse-blind' })
		).toThrow(/verified canonical|TRUTH-TAINT|truth-assisted/i);
	});
});

describe.skipIf(!existsSync(DASHS_IMAGE))(
	'Straight Test trace, CLI, and one VisualRender correspondence',
	() => {
		test('real Dashs blind run carries one deterministic matched receipt triplet with no renderer recomputation', async () => {
			const root = mkdtempSync(join(tmpdir(), 'straight-test-receipt-'));
			try {
				const result = await runSweepOperation({
					configPath: resolve(
						REPO_ROOT,
						'packages/alg/src/detectors/threeFactor/configs/straight-test-on.json'
					),
					inputPaths: [DASHS_IMAGE],
					outDir: join(root, 'out')
				});
				const trace = result.trace;
				expect(trace.runId).toMatch(/^[0-9a-f]{64}$/);
				expect(trace.imageId).toBe(result.report.imageId);
				expect(trace.traceHash).toMatch(/^[0-9a-f]{64}$/);
				expect(trace.straightTest?.featureId).toBe(STRAIGHT_TEST_FEATURE_ID);
				expect(trace.straightTest?.coordinateFrame).toBe(STRAIGHT_TEST_COORDINATE_FRAME);
				expect(result.runReceipt.visualRenders.filter((render) => render.kind === 'feature')).toHaveLength(1);
				expect(result.runReceipt.straightTest?.traceHash).toBe(trace.traceHash);
				expect(result.runReceipt.straightTest?.runId).toBe(trace.runId);
				expect(result.runReceipt.straightTest?.imageId).toBe(trace.imageId);

				const cli = readFileSync(result.runReceiptPaths[1], 'utf8');
				const visualPath = result.featureRenders.results[0]?.filesWritten.find((path) =>
					path.endsWith('run.visual.receipt.txt')
				);
				expect(visualPath).toBeTruthy();
				const visual = readFileSync(visualPath!, 'utf8');
				for (const value of [
					trace.runId,
					trace.imageId,
					trace.paramsHash,
					STRAIGHT_TEST_FEATURE_ID,
					trace.traceHash,
					STRAIGHT_TEST_COORDINATE_FRAME
				]) {
					expect(cli).toContain(value!);
					expect(visual).toContain(value!);
				}
				for (const proposal of trace.straightTest?.proposals ?? []) {
					expect(result.runReceipt.straightTest?.proposals).toContainEqual(proposal);
					expect(cli).toContain(proposal.proposalId);
					expect(visual).toContain(proposal.proposalId);
					for (const reason of proposal.reasons) {
						expect(cli).toContain(reason);
						expect(visual).toContain(reason);
					}
				}

				const sealedAgain = sealTrace(trace, {
					runId: trace.runId!,
					imageId: trace.imageId!
				});
				expect(sealedAgain.traceHash).toBe(trace.traceHash);
				expect(makeTraceRunId(trace.imageId!, trace.paramsHash, result.plan.planFingerprint)).toBe(
					trace.runId
				);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}, 90_000);

		test.skipIf(
			!existsSync(DASHS_TRUTH) ||
				process.env.LAB_TEST_RUN === '1' ||
				process.env.LAB_BLIND_TEST === '1'
		)(
			'real Dashs truth-assisted comparison retains canonical endpoint geometry in one matched tainted receipt',
			async () => {
				const root = mkdtempSync(join(tmpdir(), 'straight-test-tainted-receipt-'));
				try {
					const result = await runSweepOperation({
						configPath: resolve(
							REPO_ROOT,
							'packages/alg/src/detectors/threeFactor/configs/straight-test-truth-assisted-compare.json'
						),
						inputPaths: [DASHS_IMAGE],
						truthPath: DASHS_TRUTH,
						outDir: join(root, 'out')
					});
					const trace = result.trace;
					const straight = trace.straightTest;
					expect(straight?.truthAssistance).toMatchObject({
						mode: 'verified-canonical',
						taint: 'TRUTH-TAINT'
					});
					expect(result.runReceipt.visualRenders.filter((render) => render.kind === 'feature')).toHaveLength(1);
					const locks = straight?.truthAssistance.locks ?? [];
					const selected = (straight?.proposals ?? []).filter((proposal) => proposal.selected);
					expect(selected).toHaveLength(locks.length);
					expect(new Set(selected.map((proposal) => proposal.badgeId)).size).toBe(selected.length);
					for (const lock of locks) {
						const proposal = selected.find((row) => row.badgeId === lock.badgeId);
						expect(proposal).toMatchObject({
							verdict: 'PROVISIONAL',
							truthTainted: true,
							teeId: lock.teeId,
							basketId: lock.basketId,
							gates: { oneToOneUniqueness: 'PASS' }
						});
						expect(proposal?.geometryEndpoints).toMatchObject({
							tee: {
								xPx: lock.canonicalTee.xPx,
								yPx: lock.canonicalTee.yPx,
								provenance: 'canonical-annotation-tee'
							},
							basket: {
								xPx: lock.canonicalBasket.xPx,
								yPx: lock.canonicalBasket.yPx,
								provenance: 'canonical-annotation-basket'
							}
						});
					}
					for (const hole of [3, 5]) {
						const lock = locks.find((candidate) => candidate.holeNumber === hole);
						expect(lock?.teeReference).toBe('canonical-annotation');
						expect(lock?.teeId).toBe(`truth:H${hole}:tee`);
					}

					expect(result.runReceipt.straightTest?.proposals).toEqual(straight?.proposals);
					const cli = readFileSync(result.runReceiptPaths[1], 'utf8');
					const visualPath = result.featureRenders.results[0]?.filesWritten.find((path) =>
						path.endsWith('run.visual.receipt.txt')
					);
					expect(visualPath).toBeTruthy();
					const visual = readFileSync(visualPath!, 'utf8');
					for (const value of [
						trace.runId,
						trace.imageId,
						trace.paramsHash,
						STRAIGHT_TEST_FEATURE_ID,
						trace.traceHash,
						STRAIGHT_TEST_COORDINATE_FRAME,
						'TRUTH-TAINT'
					]) {
						expect(cli).toContain(value!);
						expect(visual).toContain(value!);
					}
					for (const proposal of selected) {
						expect(cli).toContain(proposal.proposalId);
						expect(visual).toContain(proposal.proposalId);
						for (const reason of proposal.reasons) {
							expect(cli).toContain(reason);
							expect(visual).toContain(reason);
						}
					}
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			},
			90_000
		);
	}
);
