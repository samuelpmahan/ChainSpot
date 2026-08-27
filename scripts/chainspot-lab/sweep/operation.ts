import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import {
	createExecBoard,
	executeCompiledPlan,
	validateOperationOrder,
	type CompiledExecutionPlan
} from '@chainspot/alg/exec';
import { createNodeSink } from '@chainspot/alg/exec/node-sink';
import { canonicalJson, sha256Hex } from '@chainspot/alg/detectors/threeFactor';
import {
	createTraceContext,
	resolveConfiguredParams
} from '@chainspot/alg/detectors/threeFactor/engine';
import { seedBoard } from '@chainspot/alg/detectors/threeFactor/measure';
import type { EvidenceBoard, RunTrace } from '@chainspot/alg/detectors/threeFactor/features/types';
import type {
	RawPairEvidence,
	RecoveredTeeInput,
	ThreeFactorAssignment,
	ThreeFactorMeasurement
} from '@chainspot/alg/detectors/threeFactor/types';
import type { CanonicalTruth } from '@chainspot/alg/g0/truth';
import { loadConfig } from './configIo';
import { canonicalizeInputs } from './inputShim';
import { compareTruthGrounding, loadTruth, scoreTruth } from './truthScoring';
import { renderArtifact, type ArtifactRenderResult } from './artifactIo';
import { renderTraceFeatures, type RenderTraceFeaturesOutput } from './featureRenders';
import {
	GATE_ORDER,
	isSweepThroughGate,
	type EngineGateId,
	type SweepThroughGate
} from './gateVocabulary';
import {
	buildRunReceipt,
	writeRunReceiptJson,
	type RunReceipt,
	type RunReceiptVisualRender,
	type RunPhaseTimings
} from './runReceipt';
import { formatRunReceiptText } from './runReceiptText';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);

export function canonicalSweepRunName(inputPaths: readonly string[]): string {
	if (inputPaths.length === 1) return basename(inputPaths[0], extname(inputPaths[0]));
	const first = basename(inputPaths[0], extname(inputPaths[0]));
	return `${first}-plus-${inputPaths.length - 1}-tiles`;
}

export function compileSweepConfig(configPath: string) {
	return loadConfig(configPath);
}

export interface RunSweepOperationInput {
	readonly configPath: string;
	readonly inputPaths: readonly string[];
	readonly truthPath?: string;
	readonly outDir?: string;
	readonly throughGate?: SweepThroughGate;
}

export interface RunSweepOperationResult {
	readonly configPath: string;
	readonly configName: string;
	readonly plan: ReturnType<typeof loadConfig>['plan'];
	readonly receipts: ReturnType<typeof executeCompiledPlan>;
	readonly report: Awaited<ReturnType<typeof canonicalizeInputs>>['report'];
	readonly outDir: string;
	readonly artifactRenders: readonly ArtifactRenderResult[];
	readonly featureRenders: RenderTraceFeaturesOutput;
	readonly trace: RunTrace;
	readonly renderedCount: number;
	readonly stubbedCount: number;
	readonly scoreboard?: ReturnType<typeof scoreTruth>;
	readonly measurement?: ThreeFactorMeasurement;
	readonly groundingComparisons: ReturnType<typeof compareTruthGrounding>;
	readonly truthScoringSkipped: boolean;
	readonly truthScoringReason?: string;
	readonly throughGate?: SweepThroughGate;
	readonly runReceipt: RunReceipt;
	readonly runReceiptPaths: readonly string[];
}

export interface TruthScoringDecision {
	readonly eligible: boolean;
	readonly provenanceTrusted: boolean;
	readonly reason?: string;
}

/** Decide whether a supplied truth file can support an authoritative
 * scoreboard in the canonical execution frame. Diagnostic grounding may
 * still run with provenanceTrusted=false when canonical coordinates exist. */
export function decideTruthScoring(
	report: Awaited<ReturnType<typeof canonicalizeInputs>>['report'],
	canonicalTruth: CanonicalTruth | undefined
): TruthScoringDecision {
	if (!report.truthMatch) {
		return {
			eligible: false,
			provenanceTrusted: false,
			reason: 'Supplied truth does not correspond to the canonical raster.'
		};
	}
	if (report.truthMatch.level === 'dims-only') {
		return {
			eligible: false,
			provenanceTrusted: false,
			reason:
				'Dimensions-only truth correspondence is unverified and cannot produce an official scoreboard.'
		};
	}
	if (!canonicalTruth) {
		return {
			eligible: false,
			provenanceTrusted: false,
			reason:
				'Truth coordinates were not mapped into the canonical raster; multi-input truth requires an explicit composite-frame mapping.'
		};
	}
	return { eligible: true, provenanceTrusted: true };
}

export async function slicePlanThroughGate(
	plan: CompiledExecutionPlan,
	throughGate: SweepThroughGate
): Promise<CompiledExecutionPlan> {
	if (!isSweepThroughGate(throughGate)) {
		throw new Error(
			'lab sweep: --through supports only dependency-complete cutoffs G1, G2, or G3.'
		);
	}
	const limit = GATE_ORDER.indexOf(throughGate);
	if (limit < 0) throw new Error('lab sweep: unknown --through cutoff.');
	const ops = plan.ops.filter((op) => {
		const index = GATE_ORDER.indexOf(op.gate as EngineGateId);
		return index >= 0 && index <= limit;
	});
	try {
		validateOperationOrder(ops);
	} catch (error) {
		throw new Error(
			`lab sweep: --through ${throughGate} cannot form a dependency-complete gate slice: ${(error as Error).message}`,
			{ cause: error }
		);
	}
	const planFingerprint = await sha256Hex(
		canonicalJson({ parentPlanFingerprint: plan.planFingerprint, throughGate, ops })
	);
	return { ...plan, ops, planFingerprint };
}

export async function runSweepOperation(
	input: RunSweepOperationInput
): Promise<RunSweepOperationResult> {
	const runStartedAtMs = performance.now();
	const configStartedAtMs = performance.now();
	if (!input.configPath) throw new Error('lab sweep: configPath is required.');
	if (input.inputPaths.length === 0) throw new Error('lab sweep: no input image given.');
	const inputPaths = input.inputPaths.map((path) => resolve(path));
	for (const path of inputPaths) {
		if (!IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) {
			throw new Error(`lab sweep: input '${path}' is not .png/.jpg/.jpeg.`);
		}
	}
	const truthPath = input.truthPath ? resolve(input.truthPath) : undefined;
	const truth = truthPath ? loadTruth(truthPath) : undefined;
	const configPath = resolve(input.configPath);
	const firstLoad = loadConfig(configPath);
	const paramsHash = await sha256Hex(canonicalJson(firstLoad.resolved));
	const loaded = loadConfig(configPath, paramsHash);
	const plan = input.throughGate
		? await slicePlanThroughGate(loaded.plan, input.throughGate)
		: loaded.plan;
	const configMs = performance.now() - configStartedAtMs;
	const intakeStartedAtMs = performance.now();
	const { report, image, canonicalTruth } = await canonicalizeInputs(inputPaths, truth);
	const intakeMs = performance.now() - intakeStartedAtMs;
	const outDir = input.outDir
		? resolve(input.outDir)
		: resolve(
				REPO_ROOT,
				'artifacts',
				'sweep',
				loaded.resolved.name,
				canonicalSweepRunName(inputPaths)
			);
	mkdirSync(outDir, { recursive: true });
	const canonicalWriteStartedAtMs = performance.now();
	const canonicalPngPath = resolve(outDir, 'renders', 'input', 'g0.canonical.png');
	mkdirSync(dirname(canonicalPngPath), { recursive: true });
	const canonicalPng = new PNG({ width: image.width, height: image.height });
	canonicalPng.data.set(image.data);
	writeFileSync(canonicalPngPath, PNG.sync.write(canonicalPng));
	const canonicalWriteMs = performance.now() - canonicalWriteStartedAtMs;

	const board = createExecBoard();
	seedBoard(
		board as unknown as EvidenceBoard,
		image,
		resolveConfiguredParams(undefined, loaded.resolved)
	);
	board.set('recoveredTees', []);
	const sink = createNodeSink(outDir);
	const traceResolved = input.throughGate
		? {
				...loaded.resolved,
				execution: [...new Set(plan.ops.map((op) => op.unit))]
			}
		: loaded.resolved;
	const { ctx, trace } = createTraceContext(traceResolved, plan.paramsHash ?? '', plan.ops);
	const gatewayStartedAtMs = performance.now();
	const receipts = executeCompiledPlan(plan, board, ctx, sink);
	const gatewayMs = performance.now() - gatewayStartedAtMs;
	const operationBodyMs = receipts.reduce((sum, receipt) => sum + receipt.durationMs, 0);
	const gateByOpId = new Map(plan.ops.map((op) => [op.id, op.gate]));
	const artifactRenders: ArtifactRenderResult[] = [];
	const artifactRenderOwners: Array<{ readonly opId: string; readonly gate: string }> = [];
	const artifactRenderStartedAtMs = performance.now();
	for (const receipt of receipts) {
		for (const artifactRef of receipt.artifacts) {
			artifactRenders.push(
				renderArtifact(outDir, receipt.opId, gateByOpId.get(receipt.opId) ?? 'shared', artifactRef)
			);
			artifactRenderOwners.push({
				opId: receipt.opId,
				gate: gateByOpId.get(receipt.opId) ?? 'shared'
			});
		}
	}
	const artifactRenderMs = performance.now() - artifactRenderStartedAtMs;
	const truthEvaluationStartedAtMs = performance.now();
	let scoreboard: ReturnType<typeof scoreTruth> | undefined;
	let truthScoringSkipped = false;
	let truthScoringReason: string | undefined;
	const truthDecision = decideTruthScoring(report, canonicalTruth);
	if (truth) {
		if (!truthDecision.eligible) {
			truthScoringSkipped = true;
			truthScoringReason = truthDecision.reason;
		} else {
			scoreboard = scoreTruth(board, canonicalTruth!, report.singleSourceOffset);
		}
	}
	const groundingComparisons = canonicalTruth
		? compareTruthGrounding(
				board,
				canonicalTruth,
				report.singleSourceOffset,
				truthDecision.provenanceTrusted
			)
		: [];
	const truthEvaluationMs = performance.now() - truthEvaluationStartedAtMs;
	const measurement = board.has('measurement')
		? board.get<ThreeFactorMeasurement>('measurement')
		: undefined;
	const artifactPng = (artifactId: string) =>
		artifactRenders
			.find((result) => result.rendered && result.artifactRef.id === artifactId)
			?.filesWritten.find((path) => extname(path) === '.png');
	const brightMaskPng = artifactPng('badgeStage.masks.bright');
	const darkMaskPng = artifactPng('badgeStage.masks.dark');
	const featureRenderStartedAtMs = performance.now();
	const featureRenders = renderTraceFeatures({
		run: trace,
		outDir: resolve(outDir, 'renders', 'features'),
		canvas: {
			widthPx: image.width,
			heightPx: image.height,
			source: 'LAB G0 canonical raster; the exact image executed by this sweep'
		},
		...(report.singleSourceOffset
			? {
					sourceFrameOffset: {
						...report.singleSourceOffset,
						source: 'G0 CoordinateTransformLedger inverse for the single source'
					}
				}
			: {}),
		bases: [
			{
				id: 'original',
				pngPath: canonicalPngPath,
				offsetXPx: 0,
				offsetYPx: 0,
				source: 'exact G0 canonical RGBA raster seeded into the production engine'
			},
			...(brightMaskPng
				? [
						{
							id: 'bright-mask',
							pngPath: brightMaskPng,
							offsetXPx: 0,
							offsetYPx: 0,
							source: "same sweep's badgeStage.masks.bright renderer"
						}
					]
				: []),
			...(darkMaskPng
				? [
						{
							id: 'dark-mask',
							pngPath: darkMaskPng,
							offsetXPx: 0,
							offsetYPx: 0,
							source: "same sweep's badgeStage.masks.dark renderer"
						}
					]
				: [])
		],
		truthEvaluation: { scoreboard, groundingComparisons }
	});
	const featureRenderMs = performance.now() - featureRenderStartedAtMs;

	const acceptedByUnit = (unitId: string) =>
		trace.units
			.find((unit) => unit.id === unitId)
			?.drawables.filter((drawable) => drawable.verdict === 'accepted').length;
	const recoveredTees = board.has('recoveredTees')
		? board.get<readonly RecoveredTeeInput[]>('recoveredTees').length
		: undefined;
	const phantomTees = acceptedByUnit('phantomTee');
	const visibleTees =
		acceptedByUnit('teeFamily') ??
		(board.has('tees') ? board.get<readonly unknown[]>('tees').length : undefined);
	const assignmentCount = board.has('assignment')
		? board.get<ThreeFactorAssignment>('assignment').assignments.length
		: undefined;
	const rawPairCount = board.has('rawPairs')
		? board.get<readonly RawPairEvidence[]>('rawPairs').length
		: undefined;
	const timings: RunPhaseTimings = {
		configMs,
		intakeMs,
		canonicalWriteMs,
		gatewayMs,
		operationBodyMs,
		artifactPersistenceMs: Math.max(0, gatewayMs - operationBodyMs),
		artifactRenderMs,
		truthEvaluationMs,
		featureRenderMs,
		observedTotalMs: performance.now() - runStartedAtMs
	};
	const runRelativePath = (path: string) => relative(outDir, path).split('\\').join('/');
	const visualRenders: RunReceiptVisualRender[] = [
		{
			kind: 'canonical',
			gate: 'G0',
			id: 'g0.canonical',
			owner: 'StripChrome + AutoStitch',
			status: 'rendered',
			summary: 'exact canonical RGBA raster executed by the engine',
			files: [runRelativePath(canonicalPngPath)]
		},
		...artifactRenders.map((render, index): RunReceiptVisualRender => ({
			kind: 'artifact',
			gate: artifactRenderOwners[index]?.gate ?? 'UNKNOWN',
			id: render.artifactRef.id,
			owner: artifactRenderOwners[index]?.opId ?? 'UNKNOWN',
			status: render.rendered ? 'rendered' : 'stub',
			summary: render.summary,
			files: render.filesWritten.map(runRelativePath)
		})),
		...featureRenders.results.map((render): RunReceiptVisualRender => ({
			kind: 'feature',
			gate: render.gate,
			id: `${render.featureId}.${render.unitId}`,
			owner: `${render.featureId}@${render.unitId}`,
			status: 'rendered',
			summary: render.summary,
			files: render.filesWritten.map(runRelativePath)
		}))
	];
	const visualGateRank = (gate: string): number => {
		if (gate === 'G0') return 0;
		const index = GATE_ORDER.indexOf(gate as EngineGateId);
		return index >= 0 ? index + 1 : GATE_ORDER.length + 1;
	};
	visualRenders.sort((a, b) => visualGateRank(a.gate) - visualGateRank(b.gate));
	let revision = 'UNKNOWN';
	try {
		const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
			cwd: REPO_ROOT,
			encoding: 'utf8'
		}).trim();
		const dirty = execFileSync('git', ['status', '--porcelain'], {
			cwd: REPO_ROOT,
			encoding: 'utf8'
		}).trim();
		revision = `${sha}${dirty ? '+dirty' : ''}`;
	} catch {
		// A source archive may not have Git metadata; UNKNOWN is honest provenance.
	}
	const runReceipt = buildRunReceipt({
		generatedAt: new Date().toISOString(),
		revision,
		configName: loaded.resolved.name,
		configPath,
		...(input.throughGate ? { throughGate: input.throughGate } : {}),
		plan,
		receipts,
		report,
		trace,
		timings,
		results: {
			badges: acceptedByUnit('badges'),
			baskets: acceptedByUnit('baskets'),
			visibleTees,
			recoveredTees,
			phantomTees,
			totalTees:
				visibleTees === undefined || recoveredTees === undefined
					? undefined
					: visibleTees + recoveredTees,
			assignments: assignmentCount,
			rawPairs: rawPairCount
		},
		visualRenders,
		truthSupplied: Boolean(truthPath),
		truthScoringSkipped,
		...(truthScoringReason ? { truthScoringReason } : {}),
		...(scoreboard ? { scoreboard } : {})
	});
	const runReceiptJsonPath = writeRunReceiptJson(outDir, runReceipt);
	const runReceiptTextPath = resolve(outDir, 'run.receipt.txt');
	writeFileSync(runReceiptTextPath, formatRunReceiptText(runReceipt));
	const runReceiptPaths = [runReceiptJsonPath, runReceiptTextPath];

	return {
		configPath: loaded.path,
		configName: loaded.resolved.name,
		plan,
		receipts,
		report,
		outDir,
		artifactRenders,
		featureRenders,
		trace,
		renderedCount: artifactRenders.filter((result) => result.rendered).length,
		stubbedCount: artifactRenders.filter((result) => !result.rendered).length,
		scoreboard,
		...(measurement ? { measurement } : {}),
		groundingComparisons,
		truthScoringSkipped,
		...(truthScoringReason ? { truthScoringReason } : {}),
		...(input.throughGate ? { throughGate: input.throughGate } : {}),
		runReceipt,
		runReceiptPaths
	};
}
