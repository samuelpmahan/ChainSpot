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

interface CountMetric {
	readonly numerator: number;
	readonly denominator: number;
	readonly passed: boolean;
	readonly definition: string;
}

interface AccuracyMetric {
	readonly numerator: number;
	readonly denominator: number;
	readonly wrong: number;
	readonly missing: number;
	readonly tolerancePx: number;
	readonly passed: boolean;
	readonly definition: string;
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
	readonly metrics: {
		readonly labeledBadges: CountMetric;
		/** Inventory only: exactly this many basket candidates were emitted. */
		readonly basketCandidateInventory: CountMetric;
		readonly teeCorrectlyAssigned?: AccuracyMetric;
		readonly basketCorrectlyAssigned?: AccuracyMetric;
	};
	readonly gate: {
		/** Backward-compatible inventory guard: detector cardinality, never correctness. */
		readonly inventoryPassed: boolean;
		/** null means this input has no ground truth and assignment was not scored. */
		readonly assignmentPassed: boolean | null;
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
	readonly semantics: {
		readonly detected: string;
		readonly candidatePresent: string;
		readonly correctlyAssigned: string;
		readonly recommended: string;
		readonly surfaced: string;
		readonly snapped: string;
		readonly semanticallyCorrect: string;
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
		'IMPORTANT: plain images have no endpoint ground truth. For those inputs',
		'this command can gate detector inventory only; it will print assignment',
		'as NOT SCORED rather than calling candidate counts "correct".',
		'',
		'Options:',
		'  --out <directory>          Report and per-image overlays',
		'  --templates <directory>    CV template pack override',
		'  --expected <count>         Expected labeled badge / basket-candidate inventory (default: 18)',
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

function normalizedScore(value: string, option: string): number {
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
				minBasketScore = normalizedScore(requireValue(argv, index, argument), argument);
				index += 1;
				break;
			default:
				throw new Error(`Unknown option '${argument}'.\n\n${usage()}`);
		}
	}

	const resolvedInputs = inputPaths.length === 0 ? [...DEFAULT_INPUTS] : inputPaths;
	if (resolvedInputs.length !== 2) throw new Error(`Expected exactly two image paths, received ${resolvedInputs.length}.\n\n${usage()}`);
	if (maxBasketCandidates <= expectedCount) {
		throw new Error('--max-baskets must be greater than --expected so the inventory gate cannot pass by truncating basket detections.');
	}
	return { inputPaths: resolvedInputs, outputDir, templateDir, expectedCount, maxTeeCandidates, maxBasketCandidates, minBasketScore };
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

function countMetric(numerator: number, denominator: number, definition: string): CountMetric {
	return { numerator, denominator, passed: numerator === denominator, definition };
}

function accuracyMetric(
	evaluation: NonNullable<CourseCliResult['teeTruthEvaluation'] | CourseCliResult['basketTruthEvaluation']>,
	definition: string
): AccuracyMetric {
	const denominator = evaluation.correctHoles.length + evaluation.wrongHoles.length + evaluation.missingHoles.length;
	return {
		numerator: evaluation.correctHoles.length,
		denominator,
		wrong: evaluation.wrongHoles.length,
		missing: evaluation.missingHoles.length,
		tolerancePx: evaluation.tolerancePx,
		passed: denominator > 0 && evaluation.correctHoles.length === denominator,
		definition
	};
}

function evaluate(result: CourseCliResult, expectedCount: number): Pick<GateImageResult, 'metrics' | 'gate'> {
	const labeledBadges = countMetric(
		result.counts.labeledNumbers,
		expectedCount,
		'Located number-badge bodies that received a hole label. This is not tee/basket correctness.'
	);
	const basketCandidateInventory = countMetric(
		result.counts.basketCandidates,
		expectedCount,
		'Basket candidates emitted by the detector. Candidate cardinality does not assert hole ownership or accuracy.'
	);
	const teeCorrectlyAssigned = result.teeTruthEvaluation
		? accuracyMetric(
			result.teeTruthEvaluation,
			'For each truth tee Hole N, the tee selected by grammar for Hole N is within the reported pixel tolerance.'
		)
		: undefined;
	const basketCorrectlyAssigned = result.basketTruthEvaluation
		? accuracyMetric(
			result.basketTruthEvaluation,
			'For each truth basket Hole N, the basket selected by grammar for Hole N is within the reported pixel tolerance.'
		)
		: undefined;
	const inventoryPassed = labeledBadges.passed && basketCandidateInventory.passed;
	const scoredAssignments = [teeCorrectlyAssigned, basketCorrectlyAssigned].filter((metric): metric is AccuracyMetric => metric !== undefined);
	const assignmentPassed = scoredAssignments.length === 0 ? null : scoredAssignments.every((metric) => metric.passed);
	const failures: string[] = [];
	if (!labeledBadges.passed) failures.push(`labeled badge inventory ${labeledBadges.numerator}/${labeledBadges.denominator}`);
	if (!basketCandidateInventory.passed) failures.push(`basket candidate inventory ${basketCandidateInventory.numerator}/${basketCandidateInventory.denominator}`);
	if (teeCorrectlyAssigned && !teeCorrectlyAssigned.passed) {
		failures.push(`correctly assigned tees ${teeCorrectlyAssigned.numerator}/${teeCorrectlyAssigned.denominator} @ <=${teeCorrectlyAssigned.tolerancePx.toFixed(2)}px`);
	}
	if (basketCorrectlyAssigned && !basketCorrectlyAssigned.passed) {
		failures.push(`correctly assigned baskets ${basketCorrectlyAssigned.numerator}/${basketCorrectlyAssigned.denominator} @ <=${basketCorrectlyAssigned.tolerancePx.toFixed(2)}px`);
	}
	return {
		metrics: {
			labeledBadges,
			basketCandidateInventory,
			...(teeCorrectlyAssigned ? { teeCorrectlyAssigned } : {}),
			...(basketCorrectlyAssigned ? { basketCorrectlyAssigned } : {})
		},
		gate: {
			inventoryPassed,
			assignmentPassed,
			passed: inventoryPassed && assignmentPassed !== false,
			failures
		}
	};
}

function metricText(metric: AccuracyMetric | undefined, label: string): string {
	return metric
		? `${label} ${metric.numerator}/${metric.denominator} @ <=${metric.tolerancePx.toFixed(2)}px`
		: `${label} NOT SCORED (no endpoint ground truth)`;
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
		const evaluated = evaluate(result, args.expectedCount);
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
			...evaluated
		};
		results.push(imageResult);
		console.log(
			`${evaluated.gate.inventoryPassed ? 'INVENTORY PASS' : 'INVENTORY FAIL'} ${basename(resolvedInput)} — ` +
			`labeled badges ${evaluated.metrics.labeledBadges.numerator}/${evaluated.metrics.labeledBadges.denominator}; ` +
			`basket candidates ${evaluated.metrics.basketCandidateInventory.numerator} (expected inventory ${evaluated.metrics.basketCandidateInventory.denominator}); ` +
			`tee candidates ${result.counts.teeCandidates}.`
		);
		console.log(
			`  ${metricText(evaluated.metrics.teeCorrectlyAssigned, 'correctly-assigned tees')}; ` +
			`${metricText(evaluated.metrics.basketCorrectlyAssigned, 'correctly-assigned baskets')}.`
		);
	}

	const report: GateReport = {
		expectedCount: args.expectedCount,
		candidateBudgets: { maxTeeCandidates: args.maxTeeCandidates, maxBasketCandidates: args.maxBasketCandidates },
		semantics: {
			detected: 'A raw detector emitted an object hypothesis. Never implies hole identity or correctness.',
			candidatePresent: 'At least one retained candidate exists for the object/hole under the scored fixture.',
			correctlyAssigned: 'The candidate selected for Hole N matches Hole N ground truth within an explicit tolerance.',
			recommended: 'The pipeline emitted an endpoint choice for Hole N.',
			surfaced: 'That recommendation actually entered user-visible/authoritative annotation state.',
			snapped: 'A local-snap attempt accepted and settled to a detected point.',
			semanticallyCorrect: 'The final user-visible point matches the declared tee/basket semantic anchor within tolerance.'
		},
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
