import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tsx = join(repoRoot, 'node_modules', '.bin', 'tsx');

function usage(): never {
	console.error('Usage: ./lab orient run [--verbose] | ./lab orient annotate <course> [--verbose]');
	process.exit(2);
}

function runScript(script: string, args: readonly string[], env = process.env) {
	const result = spawnSync(tsx, [join(repoRoot, script), ...args], {
		cwd: repoRoot,
		encoding: 'utf8',
		env,
	});
	if (result.error) throw result.error;
	return result;
}

function orientRun(verbose: boolean): void {
	const cache = process.env.NUTHING_CACHE_DIR ?? '/workspace/nuthing-work/pair-matrix-v6';
	for (const course of ['DashsTrack-full', 'HeritagePark-full', 'Lenard-full', 'TowneLake-full']) {
		for (const suffix of ['.json', '-field.bin', '-theta.bin']) {
			const path = join(cache, `${course}${suffix}`);
			if (!existsSync(path)) throw new Error(`Missing replay input: ${path}`);
		}
	}

	console.log('Running the frozen Dev72 scorer from cached measurements; focus course: DashsTrack.');
	const result = runScript('scripts/nuthing/pair-matrix-replay.ts', [
		cache,
		'--zones',
		'--simple',
		'--invariants',
		'--identity',
		'--assign',
	]);
	if (result.status !== 0) {
		process.stderr.write(result.stdout);
		process.stderr.write(result.stderr);
		process.exit(result.status ?? 1);
	}

	if (verbose) {
		process.stdout.write(result.stdout);
		process.stderr.write(result.stderr);
	} else {
		for (const line of result.stdout.split(/\r?\n/)) {
			if (line.startsWith('DashsTrack-full:')) console.log(line);
		}
	}
	if (!result.stdout.includes('DashsTrack-full: ASSIGNED exact=18/18')) {
		throw new Error('DashsTrack did not reproduce assigned exact=18/18. Analyze the run; do not request a pass.');
	}

	console.log('\nTell Sam one concise, useful thing you learned from this run.');
	console.log('Make the point understandable and attach the evidence that supports it.');
	console.log('Do not fill out a form or recite every gate.');
	console.log('\nORIENT STATUS: AWAITING SAM PASS');
}

function orientAnnotate(course: string, verbose: boolean): void {
	const artifactRoot = process.env.CHAINSPOT_LAB_ARTIFACTS ?? '/mnt/d/ChainSpot-LAB/artifacts';
	const result = runScript('scripts/lab-grid.ts', [course], {
		...process.env,
		CHAINSPOT_LAB_ARTIFACTS: artifactRoot,
	});
	if (verbose || result.status !== 0) process.stderr.write(result.stderr);
	if (result.status !== 0) {
		process.stderr.write(result.stdout);
		process.exit(result.status ?? 1);
	}
	process.stdout.write(result.stdout);
	console.log('\nOpen the labeled grid and work with Sam to choose inspection bounds.');
	console.log('For each proposed view, say what evidence it should contain and why those bounds are useful.');
	console.log('Before annotating, speculate about likely difficulties and expose the pixel evidence and assumptions behind that prediction.');
	console.log('Inspection crops are views only: all coordinates remain in the canonical cropped-raster frame.');
	console.log('\nORIENT STATUS: WAITING FOR SHARED INSPECTION BOUNDS');
}

const args = process.argv.slice(2);
const verboseIndex = args.indexOf('--verbose');
const verbose = verboseIndex >= 0;
if (verbose) args.splice(verboseIndex, 1);
if (args.includes('--verbose')) usage();

if (args[0] === 'run' && args.length === 1) orientRun(verbose);
else if (args[0] === 'annotate' && args.length === 2) orientAnnotate(args[1], verbose);
else usage();
