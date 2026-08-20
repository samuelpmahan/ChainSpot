import { spawn } from 'node:child_process';
import { cpus, homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runActiveReviewBenchmark } from './benchmark-active-review';
import type { ActiveReviewBenchmarkResult, GoldenMapFile } from './benchmark-active-review';
import type { ActiveReviewMap } from '../src/lib/autoAnnotation/activeReview';
import type { CourseCliResult } from './detect-course';
import { IMG_5641_GROUND_TRUTH, groundTruthMatchesImage } from '../src/lib/autoAnnotation/courseGroundTruth';
import type { CourseGroundTruth } from '../src/lib/autoAnnotation/courseGroundTruth';

/**
 * We have very few real course images but a large space of thresholds/knobs
 * that govern how they're read (minAutoSuggestScore, candidate budgets, and
 * whatever else grows here later). This fans every (image x config) point in
 * that space out as a concurrent `detect:course` child process, then scores
 * each result against known ground truth with the active-review benchmark,
 * so a whole sweep comes back as one report instead of N manual runs.
 */

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), '..');
const tsxBin = join(projectRoot, 'node_modules', '.bin', 'tsx');

const DEFAULT_IMAGES = [
	join(homedir(), 'Downloads', 'clean-tile-4-stitched.png'),
	join(homedir(), 'Downloads', 'IMG_5641 .jpg')
] as const;
const DEFAULT_MIN_AUTO_SUGGEST_SCORES = [0.5, 0.6, 0.7] as const;
const DEFAULT_TEE_BUDGETS = [18, 64] as const;
const DEFAULT_BASKET_BUDGETS = [18, 64] as const;
const DEFAULT_OUTPUT_DIR = '/private/tmp/chainspot-course-corpus';
/** Matches detect-course.ts's own evaluateTeeTruth tolerance convention (7 * uiScalePx). */
const GROUND_TRUTH_TOLERANCE_FACTOR = 7;

interface CorpusArgs {
	readonly images: readonly string[];
	readonly scores: readonly number[];
	readonly teeBudgets: readonly number[];
	readonly basketBudgets: readonly number[];
	readonly concurrency: number;
	readonly outputDir: string;
}

interface CorpusJob {
	readonly image: string;
	readonly minAutoSuggestScore: number;
	readonly maxTeeCandidates: number;
	readonly maxBasketCandidates: number;
	readonly outputDir: string;
	readonly label: string;
}

interface CorpusJobResult {
	readonly job: CorpusJob;
	readonly ok: boolean;
	readonly error?: string;
	readonly course?: CourseCliResult;
	readonly benchmark?: ActiveReviewBenchmarkResult;
	readonly groundTruthHoles?: number;
	readonly elapsedMs: number;
}

function usage(): string {
	return [
		'Usage: npm run benchmark:course-corpus -- [options]',
		'',
		'Fans every (image x minAutoSuggestScore x tee-budget x basket-budget)',
		'combination out as a concurrent `detect:course` run, then scores each',
		'against known ground truth (currently just IMG_5641.jpg) with the',
		'active-review benchmark. For sweeping the many thresholds/rule flows in',
		'the course-detection + active-review pipeline against the few real',
		'images actually available.',
		'',
		'Options:',
		'  --images <path,path,...>     Override the default image set',
		'  --scores <n,n,...>           minAutoSuggestScore sweep (default 0.5,0.6,0.7)',
		'  --tee-budgets <n,n,...>      maxTeeCandidates sweep (default 18,64)',
		'  --basket-budgets <n,n,...>   maxBasketCandidates sweep (default 18,64)',
		'  --concurrency <n>            Parallel worker cap (default: CPU count)',
		'  --out <directory>            Report + per-job dirs (default: /private/tmp/chainspot-course-corpus)',
		'  --help'
	].join('\n');
}

function requireValue(argv: readonly string[], index: number, option: string): string {
	const value = argv[index + 1];
	if (!value || value.startsWith('--')) throw new Error(`${option} requires a value.\n\n${usage()}`);
	return value;
}

function numberList(value: string, option: string): number[] {
	const parsed = value.split(',').map((entry) => Number(entry.trim()));
	if (parsed.length === 0 || parsed.some((entry) => !Number.isFinite(entry))) {
		throw new Error(`${option} must be a comma-separated list of numbers.\n\n${usage()}`);
	}
	return parsed;
}

function positiveInteger(value: string, option: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${option} must be a positive integer.\n\n${usage()}`);
	return parsed;
}

function parseArgs(argv: readonly string[]): CorpusArgs {
	if (argv.includes('--help')) throw new Error(usage());
	let images: string[] = [...DEFAULT_IMAGES];
	let scores: number[] = [...DEFAULT_MIN_AUTO_SUGGEST_SCORES];
	let teeBudgets: number[] = [...DEFAULT_TEE_BUDGETS];
	let basketBudgets: number[] = [...DEFAULT_BASKET_BUDGETS];
	let concurrency = cpus().length;
	let outputDir = DEFAULT_OUTPUT_DIR;

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (!argument.startsWith('--')) continue;
		switch (argument) {
			case '--images':
				images = requireValue(argv, index, argument).split(',').map((entry) => entry.trim());
				index += 1;
				break;
			case '--scores':
				scores = numberList(requireValue(argv, index, argument), argument);
				index += 1;
				break;
			case '--tee-budgets':
				teeBudgets = numberList(requireValue(argv, index, argument), argument);
				index += 1;
				break;
			case '--basket-budgets':
				basketBudgets = numberList(requireValue(argv, index, argument), argument);
				index += 1;
				break;
			case '--concurrency':
				concurrency = positiveInteger(requireValue(argv, index, argument), argument);
				index += 1;
				break;
			case '--out':
				outputDir = requireValue(argv, index, argument);
				index += 1;
				break;
			default:
				throw new Error(`Unknown option '${argument}'.\n\n${usage()}`);
		}
	}
	return { images, scores, teeBudgets, basketBudgets, concurrency, outputDir };
}

function safeSlug(path: string): string {
	const stem = basename(path).replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
	return stem || 'image';
}

function runDetectCourse(job: CorpusJob): Promise<{ readonly ok: boolean; readonly error?: string; readonly elapsedMs: number }> {
	return new Promise((resolveResult) => {
		const startedAt = performance.now();
		const child = spawn(
			tsxBin,
			[
				'scripts/detect-course.ts',
				job.image,
				'--out',
				job.outputDir,
				'--max-tees',
				String(job.maxTeeCandidates),
				'--max-baskets',
				String(job.maxBasketCandidates),
				'--min-auto-suggest-score',
				String(job.minAutoSuggestScore)
			],
			{ cwd: projectRoot, stdio: ['ignore', 'ignore', 'pipe'] }
		);
		let stderr = '';
		child.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on('error', (error) => {
			resolveResult({ ok: false, error: error.message, elapsedMs: performance.now() - startedAt });
		});
		child.on('close', (code) => {
			resolveResult({
				ok: code === 0,
				error: code === 0 ? undefined : stderr.trim() || `exit code ${code}`,
				elapsedMs: performance.now() - startedAt
			});
		});
	});
}

/** Runs `worker` over `items` with at most `concurrency` in flight at once, preserving input order in the result array. */
async function runWithConcurrency<T, R>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let nextIndex = 0;
	async function runNext(): Promise<void> {
		for (;;) {
			const index = nextIndex;
			nextIndex += 1;
			if (index >= items.length) return;
			results[index] = await worker(items[index]);
		}
	}
	await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, runNext));
	return results;
}

function nearestCandidateId(
	map: ActiveReviewMap,
	kind: 'tee' | 'basket',
	point: { readonly xPx: number; readonly yPx: number },
	tolerancePx: number
): string | undefined {
	let bestId: string | undefined;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const candidate of map.candidates) {
		if (candidate.kind !== kind) continue;
		const distance = Math.hypot(candidate.xPx - point.xPx, candidate.yPx - point.yPx);
		if (distance > tolerancePx || distance >= bestDistance) continue;
		bestDistance = distance;
		bestId = candidate.id;
	}
	return bestId;
}

/**
 * Converts hand-authored pixel-position ground truth (courseGroundTruth.ts)
 * into the candidate-ID truth `runActiveReviewBenchmark` needs, by snapping
 * each hole's expected tee/basket to the nearest real detector candidate
 * within tolerance. A hole with no close-enough candidate is simply omitted
 * rather than guessed, so a bad detector run shows up as fewer scored holes
 * instead of a false match.
 */
export function snapGroundTruthToCandidates(
	map: ActiveReviewMap,
	groundTruth: CourseGroundTruth,
	tolerancePx: number
): NonNullable<GoldenMapFile['groundTruth']> {
	const teeByHole: Record<string, string> = {};
	const basketByHole: Record<string, string> = {};
	for (const hole of groundTruth.holes) {
		const tee = nearestCandidateId(map, 'tee', hole.tee, tolerancePx);
		if (tee) teeByHole[String(hole.number)] = tee;
		const basket = nearestCandidateId(map, 'basket', hole.basket, tolerancePx);
		if (basket) basketByHole[String(hole.number)] = basket;
	}
	return { teeByHole, basketByHole };
}

async function processJob(job: CorpusJob): Promise<CorpusJobResult> {
	mkdirSync(job.outputDir, { recursive: true });
	const spawnResult = await runDetectCourse(job);
	if (!spawnResult.ok) return { job, ok: false, error: spawnResult.error, elapsedMs: spawnResult.elapsedMs };

	const course = JSON.parse(readFileSync(join(job.outputDir, 'course.json'), 'utf8')) as CourseCliResult;
	const activeReviewFile = JSON.parse(readFileSync(join(job.outputDir, 'activeReview.json'), 'utf8')) as { readonly map: ActiveReviewMap };

	let benchmark: ActiveReviewBenchmarkResult | undefined;
	let groundTruthHoles: number | undefined;
	if (groundTruthMatchesImage({ fileName: basename(job.image), widthPx: course.input.widthPx, heightPx: course.input.heightPx })) {
		const truth = snapGroundTruthToCandidates(
			activeReviewFile.map,
			IMG_5641_GROUND_TRUTH,
			GROUND_TRUTH_TOLERANCE_FACTOR * course.uiScalePx
		);
		groundTruthHoles = Object.keys(truth.teeByHole ?? {}).length + Object.keys(truth.basketByHole ?? {}).length;
		benchmark = runActiveReviewBenchmark({
			name: job.label,
			map: activeReviewFile.map,
			groundTruth: truth,
			minAutoSuggestScore: job.minAutoSuggestScore
		});
	}

	return { job, ok: true, course, benchmark, groundTruthHoles, elapsedMs: spawnResult.elapsedMs };
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const outputDir = resolve(args.outputDir);
	mkdirSync(outputDir, { recursive: true });

	for (const image of args.images) {
		if (!existsSync(resolve(image))) throw new Error(`Image does not exist: ${resolve(image)}`);
	}

	const jobs: CorpusJob[] = [];
	for (const image of args.images) {
		for (const score of args.scores) {
			for (const teeBudget of args.teeBudgets) {
				for (const basketBudget of args.basketBudgets) {
					const label = `${safeSlug(image)}__score${score}__tee${teeBudget}__basket${basketBudget}`;
					jobs.push({
						image: resolve(image),
						minAutoSuggestScore: score,
						maxTeeCandidates: teeBudget,
						maxBasketCandidates: basketBudget,
						outputDir: join(outputDir, label),
						label
					});
				}
			}
		}
	}

	console.log(`Running ${jobs.length} jobs across up to ${args.concurrency} concurrent workers...`);
	const startedAt = performance.now();
	const results = await runWithConcurrency(jobs, args.concurrency, processJob);
	const elapsedMs = performance.now() - startedAt;
	const sequentialEstimateMs = results.reduce((sum, result) => sum + result.elapsedMs, 0);

	for (const result of results) {
		if (!result.ok) {
			console.error(`FAIL ${result.job.label} — ${result.error}`);
			continue;
		}
		const course = result.course!;
		const recommendation = course.activeReview.recommendation;
		const recommendationSummary =
			recommendation.kind === 'candidate'
				? `${recommendation.candidateKind}→hole ${recommendation.holeNumber} (${(recommendation.score as number).toFixed(2)}${recommendation.belowThreshold ? ', below-thr' : ''})`
				: `none (${recommendation.reason})`;
		const benchmarkSummary = result.benchmark
			? `avgRegret ${result.benchmark.averageRegret.toFixed(3)}, fallbacks ${result.benchmark.fallbackCount}/${result.benchmark.iterations} (${result.groundTruthHoles} truth points matched)`
			: 'no ground truth for this image';
		console.log(
			`${result.job.label} — badges ${course.counts.labeledNumbers}/18, baskets ${course.counts.basketCandidates}/18, unassigned tee/basket ${course.activeReview.unassignedTees}/${course.activeReview.unassignedBaskets}, next-review ${recommendationSummary}, ${benchmarkSummary}`
		);
	}

	const speedup = sequentialEstimateMs > 0 ? sequentialEstimateMs / Math.max(1, elapsedMs) : 1;
	console.log(
		`\n${jobs.length} jobs in ${(elapsedMs / 1000).toFixed(1)}s wall-clock (${(sequentialEstimateMs / 1000).toFixed(1)}s summed if run one at a time — ${speedup.toFixed(1)}x)`
	);

	const reportPath = join(outputDir, 'corpus-report.json');
	writeFileSync(
		reportPath,
		`${JSON.stringify({ jobCount: jobs.length, concurrency: args.concurrency, elapsedMs, sequentialEstimateMs, results }, null, 2)}\n`
	);
	console.log(`Report: ${reportPath}`);

	if (results.some((result) => !result.ok)) process.exitCode = 1;
}

if (resolve(process.argv[1] ?? '') === resolve(scriptPath)) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
