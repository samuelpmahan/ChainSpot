// `lab compile CONFIG` (inspection only) and `lab sweep CONFIG INPUTS... [TRUTH]`.
// Sweep is the ONLY LAB operation that executes @chainspot/alg. CLI and LAB UI
// both call the same operation module.

import { extname } from 'node:path';
import { compileSweepConfig, runSweepOperation } from './operation';
import { printG0Report } from './inputShim';
import { printScoreboard } from './truthScoring';
import { printPlan, printTimeline } from './timeline';

function usage(): never {
	console.error([
		'Usage:',
		'  lab compile CONFIG.json',
		'  lab sweep CONFIG.json INPUT... [TRUTH.json]',
		'',
		'INPUT is one or more .png/.jpg/.jpeg captures. Sweep canonicalizes the set:',
		'  decode -> StripChrome -> AutoStitch (when N>1) -> canonical raster -> algorithm',
		'',
		'TRUTH is optional evaluation-only Annotation JSON.',
		'',
		'Clickable workbench:',
		'  lab ui'
	].join('\n'));
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
	const [configPath, ...rest] = args;
	if (!configPath || rest.length === 0) usage();
	const truthPaths = rest.filter((path) => extname(path).toLowerCase() === '.json');
	const inputPaths = rest.filter((path) => extname(path).toLowerCase() !== '.json');
	if (truthPaths.length > 1) throw new Error(`lab sweep: more than one truth JSON supplied: ${truthPaths.join(', ')}`);
	const result = await runSweepOperation({ configPath, inputPaths, truthPath: truthPaths[0] });
	console.log(`config: ${result.configName} (${result.configPath})`);
	printPlan(result.plan);
	console.log(`\n=== canonicalizing ${inputPaths.length} raster input(s) ===`);
	printG0Report(result.report);
	printTimeline(result.plan, result.receipts);
	console.log(`--- Renderer inventory: ${result.renderedCount} rendered, ${result.stubbedCount} stubbed -- outDir: ${result.outDir} ---`);
	if (truthPaths[0]) {
		if (result.truthScoringSkipped) console.log('--- Truth scoring skipped: supplied truth does not correspond to the canonical raster. ---');
		else if (result.scoreboard) printScoreboard(result.scoreboard);
	}
}

async function main(): Promise<void> {
	const [cmd, ...args] = process.argv.slice(2);
	if (cmd === 'compile') return runCompile(args);
	if (cmd === 'sweep') return runSweep(args);
	usage();
}

main().catch((error) => {
	console.error(`lab: ${(error as Error).message}`);
	process.exit(1);
});
