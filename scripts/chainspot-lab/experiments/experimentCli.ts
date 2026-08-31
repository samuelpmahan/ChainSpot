import { resolve } from 'node:path';
import { runBasketCompositionPcr, type BasketPcrTick } from './basketCompositionPcr.js';
import { runC1RectangleBorder } from './c1RectangleBorder.js';

function usage(exitCode = 0): never {
	console.error([
		'EXPERIMENT — run a bounded LAB research operation',
		'',
		'Usage:',
		'  lab experiment c1-rectangle-border --control RECEIPT.json --annotation ANNOTATION.json [--out-dir DIR]',
		'  lab experiment basket-composition-pcr --run-dir SWEEP_RUN --through T1|T2|T3|T4|T5 [--out-dir DIR]',
		'',
		'C1 rectangle-border:',
		'  Consumes the cached 16-basket C1 clean control.',
		'  Measures rectangle -> exact B/W ownership as additive evidence mass.',
		'  Factors ImageNorth and truth-assisted TrueNorth radial matrices.',
		'  Writes one SVG VisualRender plus compact text and complete JSON receipts.',
		'',
		'Basket composition PCR:',
		'  Consumes cached canonical RGBA plus mask evidence from a Sweep run.',
		'  Composes one cumulative handoff render through the requested tick.',
		'  T1 = source plus black Mask1 observations.',
		'  T2 = preserve T1 and add white Mask2 observations; no ownership claim.'
	].join('\n'));
	process.exit(exitCode);
}

function option(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index < 0) return undefined;
	if (index + 1 >= args.length) throw new Error(`lab experiment: ${name} needs a value`);
	const value = args[index + 1];
	args.splice(index, 2);
	return value;
}

async function main(): Promise<void> {
	const raw = process.argv.slice(2);
	const args = raw[0] === 'experiment' ? raw.slice(1) : raw;
	if (!args.length || args.includes('--help') || args.includes('-h')) usage(0);
	const experiment = args.shift();
	if (experiment === 'basket-composition-pcr') {
		const runDir = option(args, '--run-dir');
		const through = option(args, '--through') as BasketPcrTick | undefined;
		const outDir = option(args, '--out-dir') ?? 'artifacts/experiments/basket-composition-pcr/DashsTrack';
		if (!runDir) throw new Error('lab experiment basket-composition-pcr: --run-dir is required');
		if (!through || !['T1', 'T2', 'T3', 'T4', 'T5'].includes(through)) throw new Error("lab experiment basket-composition-pcr: --through must be T1, T2, T3, T4, or T5");
		if (args.length) throw new Error(`lab experiment basket-composition-pcr: unexpected args: ${args.join(' ')}`);
		const result = runBasketCompositionPcr({ runDir: resolve(runDir), through, outDir: resolve(outDir) });
		console.log('Basket composition PCR complete');
		console.log(`  VisualRender: ${result.visualRenderPath}`);
		console.log(`  CLI receipt:  ${result.receiptTextPath}`);
		console.log(`  JSON receipt: ${result.receiptJsonPath}`);
		return;
	}
	if (experiment !== 'c1-rectangle-border') throw new Error(`lab experiment: unknown experiment '${experiment}'`);
	const controlPath = option(args, '--control');
	const annotationPath = option(args, '--annotation');
	const outDir = option(args, '--out-dir') ?? 'artifacts/experiments/c1-rectangle-border/DashsTrack';
	if (!controlPath) throw new Error('lab experiment c1-rectangle-border: --control is required');
	if (!annotationPath) throw new Error('lab experiment c1-rectangle-border: --annotation is required for TrueNorth');
	if (args.length) throw new Error(`lab experiment c1-rectangle-border: unexpected args: ${args.join(' ')}`);
	const result = runC1RectangleBorder({ controlPath: resolve(controlPath), annotationPath: resolve(annotationPath), outDir: resolve(outDir) });
	console.log(`C1 rectangle -> border complete`);
	console.log(`  VisualRender: ${result.visualRenderPath}`);
	console.log(`  CLI receipt:  ${result.receiptTextPath}`);
	console.log(`  JSON receipt: ${result.receiptJsonPath}`);
}

await main();
