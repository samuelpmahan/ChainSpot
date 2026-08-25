import { mkdirSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createExecBoard, executeCompiledPlan } from '@chainspot/alg/exec';
import { createNodeSink } from '@chainspot/alg/exec/node-sink';
import { seedBoard } from '@chainspot/alg/detectors/threeFactor/measure';
import { nullFeatureContext, type EvidenceBoard } from '@chainspot/alg/detectors/threeFactor/features/types';
import { loadConfig } from './configIo';
import { canonicalizeInputs } from './inputShim';
import { loadTruth, scoreTruth } from './truthScoring';
import { renderArtifact, type ArtifactRenderResult } from './artifactIo';

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
}

export interface RunSweepOperationResult {
	readonly configPath: string;
	readonly configName: string;
	readonly plan: ReturnType<typeof loadConfig>['plan'];
	readonly receipts: ReturnType<typeof executeCompiledPlan>;
	readonly report: Awaited<ReturnType<typeof canonicalizeInputs>>['report'];
	readonly outDir: string;
	readonly artifactRenders: readonly ArtifactRenderResult[];
	readonly renderedCount: number;
	readonly stubbedCount: number;
	readonly scoreboard?: ReturnType<typeof scoreTruth>;
	readonly truthScoringSkipped: boolean;
}

export async function runSweepOperation(input: RunSweepOperationInput): Promise<RunSweepOperationResult> {
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
	const loaded = loadConfig(resolve(input.configPath));
	const { report, image, canonicalTruth } = await canonicalizeInputs(inputPaths, truth);
	const outDir = input.outDir
		? resolve(input.outDir)
		: resolve(REPO_ROOT, 'artifacts', 'sweep', loaded.resolved.name, canonicalSweepRunName(inputPaths));
	mkdirSync(outDir, { recursive: true });

	const board = createExecBoard();
	seedBoard(board as unknown as EvidenceBoard, image, undefined);
	board.set('recoveredTees', []);
	const sink = createNodeSink(outDir);
	const receipts = executeCompiledPlan(loaded.plan, board, nullFeatureContext, sink);
	const gateByOpId = new Map(loaded.plan.ops.map((op) => [op.id, op.gate]));
	const artifactRenders: ArtifactRenderResult[] = [];
	for (const receipt of receipts) {
		for (const artifactRef of receipt.artifacts) {
			artifactRenders.push(renderArtifact(outDir, receipt.opId, gateByOpId.get(receipt.opId) ?? 'shared', artifactRef));
		}
	}

	let scoreboard: ReturnType<typeof scoreTruth> | undefined;
	let truthScoringSkipped = false;
	if (truth) {
		if (!report.truthMatch) truthScoringSkipped = true;
		else scoreboard = scoreTruth(board, canonicalTruth ?? truth);
	}

	return {
		configPath: loaded.path,
		configName: loaded.resolved.name,
		plan: loaded.plan,
		receipts,
		report,
		outDir,
		artifactRenders,
		renderedCount: artifactRenders.filter((result) => result.rendered).length,
		stubbedCount: artifactRenders.filter((result) => !result.rendered).length,
		scoreboard,
		truthScoringSkipped
	};
}
