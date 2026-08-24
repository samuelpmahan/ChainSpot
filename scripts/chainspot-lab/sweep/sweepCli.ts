// `./lab compile CONFIG` (inspection only) and `./lab sweep CONFIG
// INPUTS... [TRUTH]` (the ONLY LAB command that executes @chainspot/alg).
// See scripts/chainspot-lab/README.md for usage and the B-shim boundary.
//
// LAB's job here is thin on purpose: load a config, hand it to the ONE
// gateway (executeCompiledPlan), and present what came back. It never
// touches detector mathematics -- everything printed below is a config
// file, a compiled plan, a Receipt, or a board slot the algorithm already
// produced.

import { mkdirSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createExecBoard, executeCompiledPlan } from '@chainspot/alg/exec';
import { createNodeSink } from '@chainspot/alg/exec/node-sink';
import { seedBoard } from '@chainspot/alg/detectors/threeFactor/measure';
import { nullFeatureContext, type EvidenceBoard } from '@chainspot/alg/detectors/threeFactor/features/types';
import { loadConfig } from './configIo';
import { decodeInput, printG0Report } from './inputShim';
import { loadTruth, scoreTruth, printScoreboard } from './truthScoring';
import { printPlan, printTimeline } from './timeline';
import { renderArtifact } from './artifactIo';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');

function usage(): never {
	console.error(
		[
			'Usage:',
			'  lab compile CONFIG.json                         inspect a config -- no execution',
			'  lab sweep CONFIG.json INPUT... [TRUTH.json]      run the exec gateway against one or more images',
			'',
			'INPUT is a .png/.jpg/.jpeg file. TRUTH (optional) is an Annotation JSON file --',
			'detected by .json extension among the trailing args, distinct from CONFIG (the first arg).',
			'',
			'Examples:',
			'  ./lab compile packages/alg/src/detectors/threeFactor/configs/default.json',
			'  ./lab sweep packages/alg/src/detectors/threeFactor/configs/default.json \\',
			'      ../chainspot-corpus/dev/DashsTrack/DashsTrack-full.jpg \\',
			'      ../chainspot-corpus/dev/DashsTrack/DashsTrack-full.annotation.json'
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

async function runSweep(args: readonly string[]): Promise<void> {
	const [configPath, ...rest] = args;
	if (!configPath || rest.length === 0) usage();

	const truthPaths = rest.filter((p) => extname(p).toLowerCase() === '.json');
	const inputPaths = rest.filter((p) => extname(p).toLowerCase() !== '.json');
	if (truthPaths.length > 1) throw new Error(`lab sweep: more than one .json trailing arg given as truth: ${truthPaths.join(', ')}`);
	if (inputPaths.length === 0) throw new Error('lab sweep: no input image given.');
	for (const p of inputPaths) {
		if (!IMAGE_EXTENSIONS.has(extname(p).toLowerCase())) {
			throw new Error(`lab sweep: input '${p}' is not .png/.jpg/.jpeg.`);
		}
	}

	const truth = truthPaths[0] ? loadTruth(truthPaths[0]) : undefined;
	const { path: resolvedConfigPath, resolved, plan } = loadConfig(configPath);
	console.log(`config: ${resolved.name} (${resolvedConfigPath})`);
	printPlan(plan);

	for (const inputPath of inputPaths) {
		console.log(`\n=== sweeping ${inputPath} ===`);
		const { report, image } = await decodeInput(inputPath, truth);
		printG0Report(report);

		const outDir = resolve(REPO_ROOT, 'artifacts', 'sweep', resolved.name, basename(inputPath, extname(inputPath)));
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
		console.log(`--- Renderer inventory: ${rendered} rendered, ${stubbed} stubbed (raw bytes + note) -- outDir: ${outDir} ---`);

		if (truth) {
			const scoreboard = scoreTruth(board, truth);
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
