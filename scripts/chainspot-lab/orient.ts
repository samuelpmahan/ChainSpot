import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tsx = join(repoRoot, 'node_modules', '.bin', 'tsx');
const devCourses = ['DashsTrack-full', 'HeritagePark-full', 'Lenard-full', 'TowneLake-full'] as const;
const corpusRasters: Record<(typeof devCourses)[number], string> = {
	'DashsTrack-full': 'dev/DashsTrack/DashsTrack-full.jpg',
	'HeritagePark-full': 'dev/Heritage/HeritagePark-full.png',
	'Lenard-full': 'dev/Lenard/Lenard-full.PNG',
	'TowneLake-full': 'dev/TowneLake/TowneLake-full.png',
};

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

function run(command: string, args: readonly string[], env = process.env) {
	const result = spawnSync(command, args, { cwd: repoRoot, encoding: 'utf8', env });
	if (result.error) throw result.error;
	return result;
}

function ensureCorpus(corpusRoot: string): void {
	if (devCourses.every((course) => existsSync(join(corpusRoot, corpusRasters[course])))) return;
	if (existsSync(corpusRoot)) {
		throw new Error(`Incomplete corpus checkout: ${corpusRoot}`);
	}
	console.log(`Corpus checkout is absent; cloning the canonical input into ${corpusRoot}.`);
	const cloned = run(
		'git',
		['clone', '--filter=blob:none', 'https://github.com/samuelpmahan/chainspot-corpus.git', corpusRoot],
		{ ...process.env, GIT_LFS_SKIP_SMUDGE: '1' },
	);
	process.stdout.write(cloned.stdout);
	process.stderr.write(cloned.stderr);
	if (cloned.status !== 0) process.exit(cloned.status ?? 1);
	const hydrated = run('git', [
		'-C',
		corpusRoot,
		'lfs',
		'pull',
		`--include=${Object.values(corpusRasters).join(',')}`,
	]);
	process.stdout.write(hydrated.stdout);
	process.stderr.write(hydrated.stderr);
	if (hydrated.status !== 0) process.exit(hydrated.status ?? 1);
}

function ensureTrace(course: (typeof devCourses)[number], corpusRoot: string, traceDir: string): void {
	const trace = join(traceDir, `${course}.rgba.bin`);
	if (existsSync(trace)) return;
	const source = join(corpusRoot, corpusRasters[course]);
	const header = readFileSync(source, { encoding: 'utf8', flag: 'r' }).slice(0, 80);
	if (header.startsWith('version https://git-lfs')) throw new Error(`Corpus raster is an unhydrated LFS pointer: ${source}`);
	mkdirSync(traceDir, { recursive: true });
	console.log(`Decoding canonical raster for ${course}...`);
	const traced = run('uv', [
		'run',
		'--with',
		'numpy',
		'--with',
		'opencv-python-headless',
		'python',
		join(repoRoot, 'scripts', 'nuthing', 'p1_trace.py'),
		source,
		traceDir,
		'--name',
		course,
	]);
	process.stdout.write(traced.stdout);
	process.stderr.write(traced.stderr);
	if (traced.status !== 0) process.exit(traced.status ?? 1);
}

function orientRun(verbose: boolean): void {
	const cache = process.env.NUTHING_CACHE_DIR ?? '/workspace/nuthing-work/pair-matrix-v6';
	const traceDir = process.env.NUTHING_TRACE_DIR ?? join(cache, 'source-rgba');
	const corpusRoot = process.env.CHAINSPOT_CORPUS_PATH ?? resolve(repoRoot, '..', 'chainspot-corpus');
	const missingCourses: string[] = [];
	for (const course of devCourses) {
		if (['.json', '-field.bin', '-theta.bin'].some((suffix) => !existsSync(join(cache, `${course}${suffix}`)))) {
			missingCourses.push(course);
		}
	}
	if (missingCourses.length > 0) {
		ensureCorpus(corpusRoot);
		console.log(`Measurement cache is cold; generating ${missingCourses.length} course(s) before replay.`);
		for (const course of missingCourses) {
			ensureTrace(course as (typeof devCourses)[number], corpusRoot, traceDir);
			console.log(`Measuring ${course}...`);
			const measured = runScript(
				'scripts/nuthing/pair-matrix.ts',
				[cache, '--course', course, '--patch-badges'],
				{ ...process.env, CHAINSPOT_CORPUS_PATH: corpusRoot, NUTHING_TRACE_DIR: traceDir },
			);
			if (verbose) process.stdout.write(measured.stdout);
			process.stderr.write(measured.stderr);
			if (measured.status !== 0) process.exit(measured.status ?? 1);
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
	if (!result.stdout.includes('ASSIGNED exact=72/72')) {
		throw new Error('Dev72 did not reproduce assigned exact=72/72. Analyze the cache recipe; do not request a pass.');
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
