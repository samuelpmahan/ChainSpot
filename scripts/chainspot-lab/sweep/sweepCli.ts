// `lab compile CONFIG` (inspection only) and `lab sweep CONFIG INPUTS... [TRUTH]`.
// Sweep owns raster canonicalization and is the ONLY LAB command that executes
// @chainspot/alg. Scope may call Sweep's intake seam, but never the algorithm gateway.

import { mkdirSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createExecBoard, executeCompiledPlan } from '@chainspot/alg/exec';
import { createNodeSink } from '@chainspot/alg/exec/node-sink';
import { seedBoard } from '@chainspot/alg/detectors/threeFactor/measure';
import { nullFeatureContext, type EvidenceBoard } from '@chainspot/alg/detectors/threeFactor/features/types';
import { loadConfig } from './configIo';
import { canonicalizeInputs, printG0Report } from './inputShim';
import { loadTruth, scoreTruth, printScoreboard } from './truthScoring';
import { printPlan, printTimeline } from './timeline';
import { renderArtifact } from './artifactIo';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');

function usage(): never {
	console.error(
		[
			'Usage:',
			'  lab compile CONFIG.json',
			'  lab sweep CONFIG.json INPUT... [TRUTH.json]',
			'',
			'INPUT is one or more .png/.jpg/.jpeg captures. Sweep canonicalizes the set:',
			'  decode -> StripChrome -> AutoStitch (when N>1) -> canonical raster -> algorithm',
			'',
			'TRUTH is optional evaluation-only Annotation JSON.',
			'',
			'Example:',
			'  ./lab sweep packages/alg/src/detectors/threeFactor/configs/default.json \\',
			'      ../chainspot-corpus/dev/Annotated/DashsTrack/DashsTrack-full.jpg \\',
			'      ../chainspot-corpus/dev/Annotated/DashsTrack/DashsTrack-full.annotation.json'
		].join('\n')
	);
	process.exit(2);
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);

async function runCompile(args: readonly string[]): Promise<void> {
	const [configPath] = args;
	if (!configPath) usage();
	const { resolved, plan } = loadConfig(configPath);
	console.log(`config: ${resolved.name}`);
	printPlan(plan);
}

function canonicalRunName(inputPaths: readonly string[]): string {
	if (inputPaths.length === 1) return basename(inputPaths[0], extname(inputPaths[0]));
	const first = basename(inputPaths[0], extname(inputPaths[0]));
	return `${first}-plus-${inputPaths.length - 1}-tiles`;
}

async function runSweep(args: readonly string[]): Promise<void> {
	const [configPath, ...rest] = args;
	if (!configPath || rest.length === 0) usage();

	const truthPaths = rest.filter((p) => extname(p).toLowerCase() === '.json');
	const inputPaths = rest.filter((p) => extname(p).toLowerCase() !== '.json');
	if (truthPaths.length > 1) throw new Error(`lab sweep: more than one truth JSON supplied: ${truthPaths.join(', ')}`);
	if (inputPaths.length === 0) throw new Error('lab sweep: no input image given.');
	for (const p of inputPaths) {
		if (!IMAGE_EXTENSIONS.has(extname(p).toLowerCase())) throw new Error(`lab sweep: input '${p}' is not .png/.jpg/.jpeg.`);
	}

	const truth = truthPaths[0] ? loadTruth(truthPaths[0]) : undefined;
	const { path: resolvedConfigPath, resolved, plan } = loadConfig(configPath);
	console.log(`config: ${resolved.name} (${resolvedConfigPath})`);
	printPlan(plan);

	console.log(`\n=== canonicalizing ${inputPaths.length} raster input(s) ===`);
	const { report, image, canonicalTruth } = await canonicalizeInputs(inputPaths, truth);
	printG0Report(report);

	const outDir = resolve(REPO_ROOT, 'artifacts', 'sweep', resolved.name, canonicalRunName(inputPaths));
	mkdirSync(outDir, { recursive: true });

	const board = createExecBoard();
	seedBoard(board as unknown as EvidenceBoard, image, undefined);
	board.set('recoveredTees', []);

	const sink = createNodeSink(outDir);
	const receipts = executeCompiledPlan(plan, board, nullFeatureContext, sink);
	printTimeline(plan, receipts);

	const gateByOpId = new Map(plan.ops.map((op) => [op.id, op.gate]));
	let rendered = 0;
	let stubbed = 0;
	for (const receipt of receipts) {
		for (const artifactRef of receipt.artifacts) {
			const result = renderArtifact(outDir, receipt.opId, gateByOpId.get(receipt.opId) ?? 'shared', artifactRef);
			if (result.rendered) rendered++;
			else stubbed++;
		}
	}
	console.log(`--- Renderer inventory: ${rendered} rendered, ${stubbed} stubbed -- outDir: ${outDir} ---`);

	if (truth) {
		if (!report.truthMatch) {
			console.log('--- Truth scoring skipped: supplied truth does not correspond to the canonical raster. ---');
		} else {
			const scoreboard = scoreTruth(board, canonicalTruth ?? truth);
			printScoreboard(scoreboard);
		}
	}
}

async function main(): Promise<void> {
	const [cmd, ...args] = process.argv.slice(2);
	if (cmd === 'compile') return runCompile(args);
	if (cmd === 'sweep') return runSweep(args);
	usage();
}

main().catch((err) => {
	console.error(`lab: ${(err as Error).message}`);
	process.exit(1);
});
