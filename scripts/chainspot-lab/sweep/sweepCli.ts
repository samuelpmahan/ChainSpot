// `lab compile CONFIG` (inspection only) and `lab sweep CONFIG INPUTS... [TRUTH]`.
// Sweep is the ONLY LAB operation that executes @chainspot/alg. CLI and LAB UI
// both call the same operation module.

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { compileSweepConfig, runSweepOperation } from './operation';
import { printPlan } from './timeline';
import { isSweepThroughGate, type SweepThroughGate } from './gateVocabulary';
import { runSweepBatch } from './batch';

function usage(): never {
	console.error(
		[
			'Usage:',
			'  lab compile CONFIG.json',
			'  lab sweep CONFIG.json INPUT... [TRUTH.json]',
			'  lab sweep --through GATE CONFIG.json INPUT... [TRUTH.json]',
			'  lab sweep batch [--through GATE] CONFIG.json [dev|demo|all|COURSE]...',
			'',
			'INPUT is one or more .png/.jpg/.jpeg captures. Sweep canonicalizes the set:',
			'  decode -> StripChrome -> AutoStitch (when N>1) -> canonical raster -> algorithm',
			'',
			'TRUTH is optional evaluation-only Annotation JSON.',
			'--through GATE (G1-G7) executes the dependency-complete chronological',
			'prefix through that gate; the receipt states what was not scheduled and why.',
			'',
			'Clickable workbench:',
			'  lab ui'
		].join('\n')
	);
	process.exit(2);
}

async function runCompile(args: readonly string[]): Promise<void> {
	const [configPath] = args;
	if (!configPath) usage();
	const { resolved, plan } = compileSweepConfig(configPath);
	console.log(`config: ${resolved.name}`);
	printPlan(plan);
}

async function runSweep(args: readonly string[]): Promise<void> {
	if (args[0] === 'batch') {
		process.exitCode = await runSweepBatch(args);
		return;
	}
	const restArgs = [...args];
	let throughGate: SweepThroughGate | undefined;
	const throughIndex = restArgs.indexOf('--through');
	if (throughIndex >= 0) {
		const value = restArgs[throughIndex + 1];
		if (!value || !isSweepThroughGate(value)) {
			throw new Error(`lab sweep: --through requires a gate cutoff G1 through G7.`);
		}
		throughGate = value;
		restArgs.splice(throughIndex, 2);
	}
	const [configPath, ...rest] = restArgs;
	if (!configPath || rest.length === 0) usage();
	const truthPaths = rest.filter((path) => extname(path).toLowerCase() === '.json');
	const inputPaths = rest.filter((path) => extname(path).toLowerCase() !== '.json');
	if (truthPaths.length > 1)
		throw new Error(`lab sweep: more than one truth JSON supplied: ${truthPaths.join(', ')}`);
	const result = await runSweepOperation({
		configPath,
		inputPaths,
		truthPath: truthPaths[0],
		...(throughGate ? { throughGate } : {})
	});
	console.log(readFileSync(result.runReceiptPaths[1], 'utf8').trimEnd());
}

async function main(): Promise<void> {
	const [cmd, ...args] = process.argv.slice(2);
	if (cmd === 'compile') return runCompile(args);
	if (cmd === 'sweep') return runSweep(args);
	usage();
}

main().catch((error) => {
	console.error(`lab: ${(error as Error).message}`);
	if (error instanceof Error && error.stack) {
		console.error(error.stack);
	}
	process.exit(1);
});
