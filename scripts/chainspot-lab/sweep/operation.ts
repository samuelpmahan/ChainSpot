import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
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
import { createTraceContext } from '@chainspot/alg/detectors/threeFactor/engine';
import { seedBoard } from '@chainspot/alg/detectors/threeFactor/measure';
import type { EvidenceBoard, RunTrace } from '@chainspot/alg/detectors/threeFactor/features/types';
import { loadConfig } from './configIo';
import { canonicalizeInputs } from './inputShim';
import { compareTruthGrounding, loadTruth, scoreTruth } from './truthScoring';
import { renderArtifact, type ArtifactRenderResult } from './artifactIo';
import { renderTraceFeatures, type RenderTraceFeaturesOutput } from './featureRenders';
import { GATE_ORDER, type EngineGateId } from './gateVocabulary';

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
	readonly throughGate?: EngineGateId;
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
	readonly groundingComparisons: ReturnType<typeof compareTruthGrounding>;
	readonly truthScoringSkipped: boolean;
	readonly throughGate?: EngineGateId;
}

export async function slicePlanThroughGate(
	plan: CompiledExecutionPlan,
	throughGate: EngineGateId
): Promise<CompiledExecutionPlan> {
	const limit = GATE_ORDER.indexOf(throughGate);
	if (limit < 0 || throughGate === 'shared') {
		throw new Error(`lab sweep: --through requires an algorithm gate such as G1, G2, or G3.`);
	}
	const ops = plan.ops.filter((op) => {
		const index = GATE_ORDER.indexOf(op.gate as EngineGateId);
		return index >= 0 && index <= limit;
	});
	try {
		validateOperationOrder(ops);
	} catch (error) {
		throw new Error(
			`lab sweep: --through ${throughGate} cannot form a dependency-complete gate slice: ${(error as Error).message}`
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
	const { report, image, canonicalTruth } = await canonicalizeInputs(inputPaths, truth);
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
	const canonicalPngPath = resolve(outDir, 'renders', 'input', 'g0.canonical.png');
	mkdirSync(dirname(canonicalPngPath), { recursive: true });
	const canonicalPng = new PNG({ width: image.width, height: image.height });
	canonicalPng.data.set(image.data);
	writeFileSync(canonicalPngPath, PNG.sync.write(canonicalPng));

	const board = createExecBoard();
	seedBoard(board as unknown as EvidenceBoard, image, undefined);
	board.set('recoveredTees', []);
	const sink = createNodeSink(outDir);
	const traceResolved = input.throughGate
		? {
				...loaded.resolved,
				execution: [...new Set(plan.ops.map((op) => op.unit))]
			}
		: loaded.resolved;
	const { ctx, trace } = createTraceContext(traceResolved, plan.paramsHash ?? '');
	const receipts = executeCompiledPlan(plan, board, ctx, sink);
	const gateByOpId = new Map(plan.ops.map((op) => [op.id, op.gate]));
	const artifactRenders: ArtifactRenderResult[] = [];
	for (const receipt of receipts) {
		for (const artifactRef of receipt.artifacts) {
			artifactRenders.push(
				renderArtifact(outDir, receipt.opId, gateByOpId.get(receipt.opId) ?? 'shared', artifactRef)
			);
		}
	}
	let scoreboard: ReturnType<typeof scoreTruth> | undefined;
	let truthScoringSkipped = false;
	if (truth) {
		if (!report.truthMatch) truthScoringSkipped = true;
		else scoreboard = scoreTruth(board, canonicalTruth ?? truth, report.singleSourceOffset);
	}
	const groundingComparisons = canonicalTruth
		? compareTruthGrounding(board, canonicalTruth, report.singleSourceOffset, report.truthMatch !== null)
		: [];
	const artifactPng = (artifactId: string) =>
		artifactRenders
			.find((result) => result.rendered && result.artifactRef.id === artifactId)
			?.filesWritten.find((path) => extname(path) === '.png');
	const brightMaskPng = artifactPng('badgeStage.masks.bright');
	const darkMaskPng = artifactPng('badgeStage.masks.dark');
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
		groundingComparisons,
		truthScoringSkipped,
		...(input.throughGate ? { throughGate: input.throughGate } : {})
	};
}
