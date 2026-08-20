import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { runCourseDetection } from './detect-course';
import type { CourseCliArgs, CourseCliResult } from './detect-course';

const EXPECTED_HOLE_COUNT = 18;
const DEFAULT_MAX_CANDIDATES = 64;
const DEFAULT_OUTPUT_DIR = '/private/tmp/chainspot-course-detection-gate';
const DEFAULT_INPUTS = [
	join(homedir(), 'Downloads', 'clean-tile-4-stitched.png'),
	join(homedir(), 'Downloads', 'IMG_5641 .jpg')
] as const;

interface GateArgs {
	readonly inputPaths: readonly string[];
	readonly outputDir: string;
	readonly templateDir?: string;
	readonly expectedCount: number;
	readonly maxTeeCandidates: number;
	readonly maxBasketCandidates: number;
	readonly minBasketScore?: number;
}

interface GateImageResult {
	readonly input: CourseCliResult['input'];
	readonly outputDir: string;
	readonly overlayPath: string;
	readonly sourceJsonPath: string;
	readonly uiScalePx: number;
	readonly basketTemplateScale: number;
	readonly mapBoundsPx?: CourseCliResult['mapBoundsPx'];
	readonly counts: CourseCliResult['counts'];
	readonly gapFallback: CourseCliResult['gapFallback'];
	readonly activeReview: CourseCliResult['activeReview'];
	readonly gate: {
		readonly labeledBadges: number;
		readonly baskets: number;
		readonly passed: boolean;
		readonly failures: readonly string[];
	};
}

interface GateReport {
	readonly expectedCount: number;
	readonly candidateBudgets: {
		readonly maxTeeCandidates: number;
		readonly maxBasketCandidates: number;
	};
	readonly passed: boolean;
	readonly results: readonly GateImageResult[];
}

function usage(): string {
	return [
		'Usage: npm run verify:course-detection -- [image-a image-b] [options]',
		'',
		'With no positional paths, checks Downloads/clean-tile-4-stitched.png and',
		'Downloads/IMG_5641 .jpg. Explicit paths replace those defaults.',
		'',
		'Options:',
		'  --out <directory>          Report and per-image overlays (default: /private/tmp/chainspot-course-detection-gate)',
		'  --templates <directory>    CV template pack override',
		'  --expected <count>         Required labeled badges and baskets (default: 18)',
		'  --max-tees <count>         Tee candidate budget (default: 64)',
		'  --max-baskets <count>      Basket candidate budget (default: 64)',
		'  --min-basket-score <0..1>  Basket NCC floor override',
		'  --help'
	].join('\n');
}

function requireValue(argv: readonly string[], index: number, option: string): string {
	const value = argv[index + 1];
	if (!value || value.startsWith('--')) throw new Error(`${option} requires a value.\n\n${usage()}`);
	return value;
}

function positiveInteger(value: string, option: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${option} must be a positive integer.`);
	return parsed;
}

function score(value: string, option: string): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new Error(`${option} must be between 0 and 1.`);
	return parsed;
}

function parseArgs(argv: readonly string[]): GateArgs {
	if (argv.includes('--help')) throw new Error(usage());
	const inputPaths: string[] = [];
	let outputDir = DEFAULT_OUTPUT_DIR;
	let templateDir: string | undefined;
	let expectedCount = EXPECTED_HOLE_COUNT;
	let maxTeeCandidates = DEFAULT_MAX_CANDIDATES;
	let maxBasketCandidates = DEFAULT_MAX_CANDIDATES;
	let minBasketScore: number | undefined;

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (!argument.startsWith('--')) {
			inputPaths.push(argument);
			continue;
		}
		switch (argument) {
			case '--out':
				outputDir = requireValue(argv, index, argument);
				index += 1;
				break;
			case '--templates':
				templateDir = requireValue(argv, index, argument);
				index += 1;
				break;
			case '--expected':
				expectedCount = positiveInteger(requireValue(argv, index, argument), argument);
				index += 1;
				break;
			case '--max-tees':
				maxTeeCandidates = positiveInteger(requireValue(argv, index, argument), argument);
				index += 1;
				break;
			case '--max-baskets':
				maxBasketCandidates = positiveInteger(requireValue(argv, index, argument), argument);
				index += 1;
				break;
			case '--min-basket-score':
				minBasketScore = score(requireValue(argv, index, argument), argument);
				index += 1;
				break;
			default:
				throw new Error(`Unknown option '${argument}'.\n\n${usage()}`);
		}
	}

	const resolvedInputs = inputPaths.length === 0 ? [...DEFAULT_INPUTS] : inputPaths;
	if (resolvedInputs.length !== 2) throw new Error(`Expected exactly two image paths, received ${resolvedInputs.length}.\n\n${usage()}`);
	if (maxBasketCandidates <= expectedCount) {
		throw new Error('--max-baskets must be greater than --expected so the gate cannot pass by truncating basket detections.');
	}
	return {
		inputPaths: resolvedInputs,
		outputDir,
		templateDir,
		expectedCount,
		maxTeeCandidates,
		maxBasketCandidates,
		minBasketScore
	};
}

function safeSlug(path: string, index: number): string {
	const stem = basename(path).replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
	return `${String(index + 1).padStart(2, '0')}-${stem || 'image'}`;
}

function runQuiet(args: CourseCliArgs): Promise<CourseCliResult> {
	const originalLog = console.log;
	console.log = () => undefined;
	return runCourseDetection(args).finally(() => {
		console.log = originalLog;
	});
}

function evaluate(result: CourseCliResult, expectedCount: number): GateImageResult['gate'] {
	const failures: string[] = [];
	if (result.counts.labeledNumbers !== expectedCount) {
		failures.push(`labeled badges ${result.counts.labeledNumbers}/${expectedCount}`);
	}
	if (result.counts.basketCandidates !== expectedCount) {
		failures.push(`baskets ${result.counts.basketCandidates}/${expectedCount}`);
	}
	return {
		labeledBadges: result.counts.labeledNumbers,
		baskets: result.counts.basketCandidates,
		passed: failures.length === 0,
		failures
	};
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const outputDir = resolve(args.outputDir);
	mkdirSync(outputDir, { recursive: true });
	const results: GateImageResult[] = [];

	for (const [index, inputPath] of args.inputPaths.entries()) {
		const resolvedInput = resolve(inputPath);
		if (!existsSync(resolvedInput)) throw new Error(`Reference image does not exist: ${resolvedInput}`);
		const imageOutputDir = join(outputDir, safeSlug(resolvedInput, index));
		const result = await runQuiet({
			inputPath: resolvedInput,
			outputDir: imageOutputDir,
			templateDir: args.templateDir ?? resolve('static/resources/chainspot_cv_templates'),
			maxTeeCandidates: args.maxTeeCandidates,
			maxBasketCandidates: args.maxBasketCandidates,
			minBasketScore: args.minBasketScore
		});
		const gate = evaluate(result, args.expectedCount);
		const imageResult: GateImageResult = {
			input: result.input,
			outputDir: imageOutputDir,
			overlayPath: result.overlayPath,
			sourceJsonPath: join(imageOutputDir, 'course.json'),
			uiScalePx: result.uiScalePx,
			basketTemplateScale: result.basketTemplateScale,
			mapBoundsPx: result.mapBoundsPx,
			counts: result.counts,
			gapFallback: result.gapFallback,
			activeReview: result.activeReview,
			gate
		};
		results.push(imageResult);
		const recommendation = result.activeReview.recommendation;
		const nextReview =
			recommendation.kind === 'candidate'
				? `${recommendation.candidateKind}→hole ${recommendation.holeNumber} (${(recommendation.score as number).toFixed(2)}${recommendation.belowThreshold ? ', below-threshold' : ''})`
				: `none (${recommendation.reason})`;
		console.log(
			`${gate.passed ? 'PASS' : 'FAIL'} ${basename(resolvedInput)} — badges ${gate.labeledBadges}/${args.expectedCount}, baskets ${gate.baskets}/${args.expectedCount}, tees ${result.counts.teeCandidates}, uiScale ${result.uiScalePx.toFixed(3)}, basketScale ${result.basketTemplateScale.toFixed(3)}, unassigned tee/basket ${result.activeReview.unassignedTees}/${result.activeReview.unassignedBaskets}, next-review ${nextReview}`
		);
	}

	const report: GateReport = {
		expectedCount: args.expectedCount,
		candidateBudgets: { maxTeeCandidates: args.maxTeeCandidates, maxBasketCandidates: args.maxBasketCandidates },
		passed: results.every((result) => result.gate.passed),
		results
	};
	const reportPath = join(outputDir, 'report.json');
	writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
	console.log(`Report: ${reportPath}`);
	if (!report.passed) {
		for (const result of results.filter((entry) => !entry.gate.passed)) {
			console.error(`${basename(result.input.path)} failed: ${result.gate.failures.join(', ')}`);
		}
		process.exitCode = 1;
	}
}

if (resolve(process.argv[1] ?? '') === resolve(new URL(import.meta.url).pathname)) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
