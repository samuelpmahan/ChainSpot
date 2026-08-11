import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDetection as runBasketDetection } from './detect-baskets';
import { runCourseDetection } from './detect-course';
import { runDetection as runTeeDetection } from './detect-tees';
import { loadValidatedCvTemplateManifest } from './cv-template-manifest';

type RunMode = 'gate' | 'dev';
type DetectorName = 'numbers' | 'baskets' | 'tees';
type ResolutionClass = 'non-stitched' | 'stitched';
type CaseStatus = 'active' | 'pending-truth' | 'candidate';
type BasketEvaluation = 'golden-localization' | 'candidate-count-smoke';
type ResultStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'OBSERVED' | 'SKIP' | 'ERROR';

interface NumberTruth {
	readonly schemaVersion: 1;
	readonly badges: readonly Readonly<{
		label: number;
		xPx: number;
		yPx: number;
	}>[];
}

interface GalleryCase {
	readonly id: string;
	readonly detector: DetectorName;
	readonly resolutionClass: ResolutionClass;
	readonly status: CaseStatus;
	readonly inputPath: string;
	readonly truthPath?: string;
	readonly evaluation?: BasketEvaluation;
	readonly note?: string;
}

interface GalleryManifest {
	readonly schemaVersion: 1;
	readonly policy: {
		readonly numbers: {
			readonly enabled: boolean;
			readonly requiredResolutionClasses: readonly ResolutionClass[];
			readonly maxCenterErrorPx: number;
		};
		readonly baskets: {
			readonly enabled: boolean;
			readonly requiredResolutionClasses: readonly ResolutionClass[];
			readonly requiredCandidateCount: number;
			readonly maxFalsePositives: number;
			readonly associationEvaluated: false;
		};
		readonly tees: {
			readonly enabled: boolean;
			readonly reason: string;
		};
	};
	readonly cases: readonly GalleryCase[];
}

interface CaseResult {
	readonly id: string;
	readonly detector: DetectorName;
	readonly resolutionClass: ResolutionClass;
	readonly fixtureStatus: CaseStatus;
	readonly status: ResultStatus;
	readonly detail: string;
	readonly metrics?: Readonly<Record<string, unknown>>;
}

interface CliArgs {
	readonly mode: RunMode;
	readonly galleryPath: string;
	readonly caseId?: string;
	readonly outputDir?: string;
	readonly json: boolean;
}

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), '..');
const defaultGalleryPath = join(projectRoot, 'resources', 'cv-gallery', 'gallery.json');
const templateDir = join(projectRoot, 'static', 'resources', 'chainspot_cv_templates');
const runHistoryRoot = join(projectRoot, 'artifacts', 'cv-runs');

const TOP_LEVEL_KEYS = new Set(['schemaVersion', 'policy', 'cases']);
const CASE_KEYS = new Set([
	'id',
	'detector',
	'resolutionClass',
	'status',
	'inputPath',
	'truthPath',
	'evaluation',
	'note'
]);
const POLICY_KEYS = new Set(['numbers', 'baskets', 'tees']);

function fail(message: string): never {
	throw new Error(message);
}

function requireValue(argv: readonly string[], index: number, option: string): string {
	const value = argv[index + 1];
	if (!value || value.startsWith('--')) fail(`${option} requires a value.`);
	return value;
}

function parseArgs(argv: readonly string[]): CliArgs {
	let mode: RunMode = 'gate';
	let galleryPath = defaultGalleryPath;
	let caseId: string | undefined;
	let outputDir: string | undefined;
	let json = false;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		switch (argument) {
			case '--mode': {
				const value = requireValue(argv, index, argument);
				if (value !== 'gate' && value !== 'dev') fail(`--mode must be gate or dev; received '${value}'.`);
				mode = value;
				index += 1;
				break;
			}
			case '--gallery':
				galleryPath = resolve(requireValue(argv, index, argument));
				index += 1;
				break;
			case '--case':
				caseId = requireValue(argv, index, argument);
				index += 1;
				break;
			case '--out':
				outputDir = resolve(requireValue(argv, index, argument));
				index += 1;
				break;
			case '--json':
				json = true;
				break;
			default:
				fail(`Unknown option '${argument}'.`);
		}
	}
	if (mode === 'gate' && caseId) fail('--case is development-only; a merge gate must run the whole required gallery.');
	return { mode, galleryPath, caseId, outputDir, json };
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${label} must be an object.`);
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
	const unknown = Object.keys(value).filter((key) => !allowed.has(key));
	if (unknown.length > 0) {
		fail(`${label} contains unsupported keys: ${unknown.join(', ')}. Gallery fixtures describe inputs/truth/evaluation only; detector tuning is forbidden.`);
	}
}

function repoPath(path: string, label: string): string {
	const absolute = resolve(projectRoot, path);
	if (absolute !== projectRoot && !absolute.startsWith(`${projectRoot}/`)) fail(`${label} escapes the repository: ${path}`);
	return absolute;
}

function parseManifest(path: string): GalleryManifest {
	const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
	assertPlainObject(raw, 'gallery');
	rejectUnknownKeys(raw, TOP_LEVEL_KEYS, 'gallery');
	if (raw.schemaVersion !== 1) fail('gallery schemaVersion must be 1.');
	assertPlainObject(raw.policy, 'gallery.policy');
	rejectUnknownKeys(raw.policy, POLICY_KEYS, 'gallery.policy');
	if (!Array.isArray(raw.cases)) fail('gallery.cases must be an array.');
	for (const [index, item] of raw.cases.entries()) {
		assertPlainObject(item, `gallery.cases[${index}]`);
		rejectUnknownKeys(item, CASE_KEYS, `gallery.cases[${index}]`);
	}
	return raw as unknown as GalleryManifest;
}

function loadNumberTruth(path: string): NumberTruth {
	const raw = JSON.parse(readFileSync(path, 'utf8')) as NumberTruth;
	if (raw.schemaVersion !== 1 || !Array.isArray(raw.badges) || raw.badges.length === 0) {
		fail(`Invalid number truth: ${path}`);
	}
	const labels = raw.badges.map((badge) => badge.label);
	if (new Set(labels).size !== labels.length) fail(`Number truth has duplicate labels: ${path}`);
	for (const badge of raw.badges) {
		if (!Number.isInteger(badge.label) || badge.label < 1 || !Number.isFinite(badge.xPx) || !Number.isFinite(badge.yPx)) {
			fail(`Number truth contains an invalid badge: ${path}`);
		}
	}
	return raw;
}

function enabled(manifest: GalleryManifest, detector: DetectorName): boolean {
	return manifest.policy[detector].enabled;
}

function fixtureResult(fixture: GalleryCase, status: ResultStatus, detail: string, metrics?: Readonly<Record<string, unknown>>): CaseResult {
	return {
		id: fixture.id,
		detector: fixture.detector,
		resolutionClass: fixture.resolutionClass,
		fixtureStatus: fixture.status,
		status,
		detail,
		metrics
	};
}

function unavailable(fixture: GalleryCase, mode: RunMode, detail: string): CaseResult {
	return fixtureResult(fixture, mode === 'dev' ? 'SKIP' : 'BLOCKED', detail);
}

async function evaluateNumbers(
	fixture: GalleryCase,
	manifest: GalleryManifest,
	outputRoot: string,
	mode: RunMode
): Promise<CaseResult> {
	const inputPath = repoPath(fixture.inputPath, `${fixture.id}.inputPath`);
	if (!existsSync(inputPath)) return unavailable(fixture, mode, `missing input: ${fixture.inputPath}`);

	const result = await runTeeDetection({
		inputPath,
		mode: 'fused',
		outputDir: join(outputRoot, fixture.id),
		templateDir,
		maxCandidates: 18,
		ignoreCirclesPx: []
	});
	const detection = result.numberDetection;
	if (!detection) return fixtureResult(fixture, mode === 'dev' ? 'ERROR' : 'FAIL', 'number detector produced no numberDetection result');

	const baseMetrics = {
		candidates: detection.candidateCount,
		labeled: detection.labeledCount,
		labeling: detection.labeling,
		labels: detection.candidates.map((candidate) => candidate.label ?? null),
		uiScalePx: result.uiScalePx,
		candidateCenters: detection.candidates.map((candidate) => ({
			label: candidate.label ?? null,
			xPx: candidate.xPx,
			yPx: candidate.yPx
		}))
	};

	if (!fixture.truthPath) {
		if (mode === 'gate') return fixtureResult(fixture, 'BLOCKED', 'number gate has no truthPath', baseMetrics);
		return fixtureResult(
			fixture,
			'OBSERVED',
			`${detection.candidateCount} candidates · ${detection.labeledCount} labeled · labels [${baseMetrics.labels.join(', ')}]`,
			baseMetrics
		);
	}
	const truthPath = repoPath(fixture.truthPath, `${fixture.id}.truthPath`);
	if (!existsSync(truthPath)) return unavailable(fixture, mode, `missing truth: ${fixture.truthPath}`);
	const truth = loadNumberTruth(truthPath);
	const expectedLabels = truth.badges.map((badge) => badge.label).sort((a, b) => a - b);
	const actualLabels = detection.candidates
		.map((candidate) => candidate.label)
		.filter((label): label is number => Number.isInteger(label))
		.sort((a, b) => a - b);
	const errors: string[] = [];
	if (detection.labeling !== 'assigned') errors.push(`labeling=${detection.labeling}, expected assigned`);
	if (detection.candidateCount !== truth.badges.length) errors.push(`candidates=${detection.candidateCount}, expected ${truth.badges.length}`);
	if (detection.labeledCount !== truth.badges.length) errors.push(`labeled=${detection.labeledCount}, expected ${truth.badges.length}`);
	if (actualLabels.join(',') !== expectedLabels.join(',')) errors.push(`labels=[${actualLabels.join(',')}], expected [${expectedLabels.join(',')}]`);

	let maxCenterErrorPx = 0;
	for (const expected of truth.badges) {
		const candidate = detection.candidates.find((item) => item.label === expected.label);
		if (!candidate) {
			errors.push(`missing label ${expected.label}`);
			continue;
		}
		const distance = Math.hypot(candidate.xPx - expected.xPx, candidate.yPx - expected.yPx);
		maxCenterErrorPx = Math.max(maxCenterErrorPx, distance);
		if (distance > manifest.policy.numbers.maxCenterErrorPx) {
			errors.push(`label ${expected.label} center error ${distance.toFixed(2)}px > ${manifest.policy.numbers.maxCenterErrorPx}px`);
		}
	}
	const metrics = { ...baseMetrics, expected: truth.badges.length, maxCenterErrorPx };
	if (mode === 'dev') {
		return fixtureResult(
			fixture,
			'OBSERVED',
			`${detection.candidateCount} candidates · ${detection.labeledCount} labeled · max golden-center error ${maxCenterErrorPx.toFixed(2)}px`,
			metrics
		);
	}
	return fixtureResult(
		fixture,
		errors.length === 0 ? 'PASS' : 'FAIL',
		errors.length === 0
			? `${truth.badges.length}/${truth.badges.length} labels; max center error ${maxCenterErrorPx.toFixed(2)}px`
			: errors.join('; '),
		metrics
	);
}

async function evaluateBaskets(
	fixture: GalleryCase,
	manifest: GalleryManifest,
	outputRoot: string,
	mode: RunMode
): Promise<CaseResult> {
	const inputPath = repoPath(fixture.inputPath, `${fixture.id}.inputPath`);
	if (!existsSync(inputPath)) return unavailable(fixture, mode, `missing input: ${fixture.inputPath}`);

	if (fixture.evaluation === 'candidate-count-smoke') {
		// Deliberately runs the end-to-end course path, not detect-baskets' CLI-only
		// blind scale sweep. This smoke case exists specifically to catch scale-space
		// regressions on a stitched raster without requiring 18 more hand-labeled baskets.
		const result = await runCourseDetection({
			inputPath,
			outputDir: join(outputRoot, fixture.id),
			templateDir,
			maxTeeCandidates: 18,
			maxBasketCandidates: 18
		});
		const candidateCount = result.counts.basketCandidates;
		const metrics = {
			candidateCount,
			numberCandidates: result.counts.numberCandidates,
			labeledNumbers: result.counts.labeledNumbers,
			uiScalePx: result.uiScalePx,
			basketTemplateScale: result.basketTemplateScale,
			elapsedMs: result.elapsedMs,
			associationEvaluated: false
		};
		if (mode === 'dev') {
			return fixtureResult(fixture, 'OBSERVED', `${candidateCount} raw basket candidates · production course path`, metrics);
		}
		const expected = manifest.policy.baskets.requiredCandidateCount;
		return fixtureResult(
			fixture,
			candidateCount === expected ? 'PASS' : 'FAIL',
			`${candidateCount}/${expected} raw basket candidates; association NOT evaluated`,
			metrics
		);
	}

	if (fixture.evaluation !== 'golden-localization') {
		return unavailable(fixture, mode, 'basket fixture must declare evaluation=golden-localization or candidate-count-smoke');
	}
	const result = await runBasketDetection({
		inputPath,
		outputDir: join(outputRoot, fixture.id),
		templateDir,
		maxCandidates: manifest.policy.baskets.requiredCandidateCount
	});
	if (!result.truthEvaluation) {
		return unavailable(fixture, mode, 'golden basket case has no localization truth evaluation');
	}
	const matched = result.truthEvaluation.matchedNumbers.length;
	const falsePositives = result.truthEvaluation.falsePositiveCount;
	const metrics = {
		matched,
		missed: result.truthEvaluation.missedNumbers,
		falsePositives,
		candidateCount: result.candidateCount,
		basketScale: result.basketScale,
		associationEvaluated: false
	};
	if (mode === 'dev') {
		return fixtureResult(
			fixture,
			'OBSERVED',
			`${matched}/${result.truthEvaluation.truthCount} golden locations · ${result.candidateCount} candidates · ${falsePositives} FP`,
			metrics
		);
	}
	const errors: string[] = [];
	if (result.candidateCount !== manifest.policy.baskets.requiredCandidateCount) {
		errors.push(`candidates=${result.candidateCount}, expected ${manifest.policy.baskets.requiredCandidateCount}`);
	}
	if (matched !== manifest.policy.baskets.requiredCandidateCount) {
		errors.push(`localized=${matched}/${manifest.policy.baskets.requiredCandidateCount}`);
	}
	if (falsePositives > manifest.policy.baskets.maxFalsePositives) {
		errors.push(`false positives=${falsePositives}, max ${manifest.policy.baskets.maxFalsePositives}`);
	}
	return fixtureResult(
		fixture,
		errors.length === 0 ? 'PASS' : 'FAIL',
		errors.length === 0
			? `${matched}/${manifest.policy.baskets.requiredCandidateCount} localized; ${falsePositives} FP; association NOT evaluated`
			: `${errors.join('; ')}; association NOT evaluated`,
		metrics
	);
}

function coverageFailures(manifest: GalleryManifest): CaseResult[] {
	const results: CaseResult[] = [];
	for (const detector of ['numbers', 'baskets'] as const) {
		if (!enabled(manifest, detector)) continue;
		const active = manifest.cases.filter((fixture) => fixture.detector === detector && fixture.status === 'active');
		for (const resolutionClass of manifest.policy[detector].requiredResolutionClasses) {
			if (!active.some((fixture) => fixture.resolutionClass === resolutionClass)) {
				results.push({
					id: `${detector}-coverage-${resolutionClass}`,
					detector,
					resolutionClass,
					fixtureStatus: 'active',
					status: 'BLOCKED',
					detail: `merge gate requires at least one active ${resolutionClass} real fixture`
				});
			}
		}
	}
	return results;
}

function pendingFailures(manifest: GalleryManifest): CaseResult[] {
	return manifest.cases
		.filter((fixture) => fixture.status === 'pending-truth' && enabled(manifest, fixture.detector))
		.map((fixture) => fixtureResult(fixture, 'BLOCKED', fixture.note ?? 'fixture is pending manually verified truth'));
}

function currentGitCommit(): string | null {
	try {
		return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
			cwd: projectRoot,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore']
		}).trim();
	} catch {
		return null;
	}
}

function runId(): string {
	return new Date().toISOString().replace(/[:.]/g, '-');
}

function printGateResults(results: readonly CaseResult[], manifest: GalleryManifest): void {
	console.log('CV QUALIFICATION — MERGE GATE');
	console.log('');
	for (const detector of ['numbers', 'baskets', 'tees'] as const) {
		console.log(detector.toUpperCase() + (detector === 'baskets' ? ' — LOCALIZATION / SCALE SMOKE ONLY' : ''));
		if (!enabled(manifest, detector)) {
			console.log(`SKIP    ${manifest.policy.tees.reason}`);
			console.log('');
			continue;
		}
		for (const result of results.filter((item) => item.detector === detector)) {
			console.log(`${result.status.padEnd(7)} ${result.id}`);
			console.log(`        ${result.detail}`);
		}
		console.log('');
	}
	const passed = results.filter((result) => result.status === 'PASS').length;
	const failed = results.filter((result) => result.status === 'FAIL').length;
	const blocked = results.filter((result) => result.status === 'BLOCKED').length;
	console.log('────────────────────────────────────────');
	console.log(`${passed} passed · ${failed} failed · ${blocked} blocked`);
	console.log(failed === 0 && blocked === 0 ? 'CV QUALIFICATION: PASS' : 'CV QUALIFICATION: FAIL');
}

function printDevResults(results: readonly CaseResult[], outputRoot: string): void {
	console.log('CV GALLERY — DEVELOPMENT RUN');
	console.log('');
	for (const result of results) {
		const label = result.status === 'ERROR' ? 'ERROR' : result.status === 'SKIP' ? 'SKIP' : 'RUN';
		console.log(`${label.padEnd(6)} ${result.id} [${result.resolutionClass}]`);
		console.log(`       ${result.detail}`);
	}
	console.log('');
	console.log(`Recorded run: ${outputRoot}`);
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (!existsSync(args.galleryPath)) fail(`CV gallery manifest does not exist: ${args.galleryPath}`);
	const manifest = parseManifest(args.galleryPath);
	loadValidatedCvTemplateManifest(templateDir);

	const id = runId();
	const outputRoot = args.outputDir ?? (
		args.mode === 'dev'
			? join(runHistoryRoot, id)
			: mkdtempSync(join(tmpdir(), 'chainspot-cv-gallery-'))
	);
	mkdirSync(outputRoot, { recursive: true });
	const deleteOutput = args.mode === 'gate' && !args.outputDir;
	const results: CaseResult[] = [];
	const startedAt = new Date().toISOString();
	try {
		let fixtures = args.mode === 'dev'
			? [...manifest.cases]
			: manifest.cases.filter((fixture) => fixture.status === 'active' && enabled(manifest, fixture.detector));
		if (args.caseId) {
			fixtures = fixtures.filter((fixture) => fixture.id === args.caseId);
			if (fixtures.length === 0) fail(`No gallery case named '${args.caseId}'.`);
		}

		for (const fixture of fixtures) {
			if (args.mode === 'gate' && !enabled(manifest, fixture.detector)) continue;
			try {
				if (fixture.detector === 'numbers') {
					results.push(await evaluateNumbers(fixture, manifest, outputRoot, args.mode));
				} else if (fixture.detector === 'baskets') {
					results.push(await evaluateBaskets(fixture, manifest, outputRoot, args.mode));
				} else {
					results.push(fixtureResult(fixture, 'SKIP', manifest.policy.tees.reason));
				}
			} catch (error) {
				results.push(fixtureResult(
					fixture,
					args.mode === 'dev' ? 'ERROR' : 'FAIL',
					error instanceof Error ? error.message : String(error)
				));
			}
		}

		if (args.mode === 'gate') {
			results.push(...pendingFailures(manifest));
			results.push(...coverageFailures(manifest));
			printGateResults(results, manifest);
		} else {
			const record = {
				schemaVersion: 1,
				runId: id,
				mode: 'dev',
				startedAt,
				finishedAt: new Date().toISOString(),
				gitCommit: currentGitCommit(),
				galleryPath: args.galleryPath,
				caseFilter: args.caseId ?? null,
				results
			};
			writeFileSync(join(outputRoot, 'run.json'), `${JSON.stringify(record, null, 2)}\n`);
			printDevResults(results, outputRoot);
		}

		if (args.json) console.log(JSON.stringify({ mode: args.mode, gallery: args.galleryPath, results }, null, 2));
		if (args.mode === 'gate' && results.some((result) => result.status !== 'PASS')) process.exitCode = 1;
	} finally {
		if (deleteOutput) rmSync(outputRoot, { recursive: true, force: true });
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
