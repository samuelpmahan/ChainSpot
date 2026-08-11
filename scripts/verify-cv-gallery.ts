import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDetection as runBasketDetection } from './detect-baskets';
import { runDetection as runTeeDetection } from './detect-tees';
import { loadValidatedCvTemplateManifest } from './cv-template-manifest';

type DetectorName = 'numbers' | 'baskets' | 'tees';
type ResolutionClass = 'non-stitched' | 'stitched';
type CaseStatus = 'active' | 'pending-truth';

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
	readonly note?: string;
}

interface GalleryManifest {
	readonly schemaVersion: 1;
	readonly policy: {
		readonly requiredResolutionClasses: readonly ResolutionClass[];
		readonly numbers: {
			readonly enabled: boolean;
			readonly maxCenterErrorPx: number;
		};
		readonly baskets: {
			readonly enabled: boolean;
			readonly requiredMatched: number;
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
	readonly status: 'PASS' | 'FAIL' | 'BLOCKED';
	readonly detail: string;
	readonly metrics?: Readonly<Record<string, unknown>>;
}

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), '..');
const defaultGalleryPath = join(projectRoot, 'resources', 'cv-gallery', 'gallery.json');
const templateDir = join(projectRoot, 'static', 'resources', 'chainspot_cv_templates');

const TOP_LEVEL_KEYS = new Set(['schemaVersion', 'policy', 'cases']);
const CASE_KEYS = new Set(['id', 'detector', 'resolutionClass', 'status', 'inputPath', 'truthPath', 'note']);
const POLICY_KEYS = new Set(['requiredResolutionClasses', 'numbers', 'baskets', 'tees']);

function fail(message: string): never {
	throw new Error(message);
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${label} must be an object.`);
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
	const unknown = Object.keys(value).filter((key) => !allowed.has(key));
	if (unknown.length > 0) {
		fail(`${label} contains unsupported keys: ${unknown.join(', ')}. Gallery fixtures may contain truth/provenance only; detector tuning is forbidden.`);
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
	if (raw.schemaVersion !== 1) fail(`gallery schemaVersion must be 1.`);
	assertPlainObject(raw.policy, 'gallery.policy');
	rejectUnknownKeys(raw.policy, POLICY_KEYS, 'gallery.policy');
	if (!Array.isArray(raw.cases)) fail(`gallery.cases must be an array.`);
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

async function evaluateNumbers(
	fixture: GalleryCase,
	manifest: GalleryManifest,
	outputRoot: string
): Promise<CaseResult> {
	if (!fixture.truthPath) return { ...fixture, status: 'BLOCKED', detail: 'number case has no truthPath' };
	const inputPath = repoPath(fixture.inputPath, `${fixture.id}.inputPath`);
	const truthPath = repoPath(fixture.truthPath, `${fixture.id}.truthPath`);
	if (!existsSync(inputPath)) return { ...fixture, status: 'BLOCKED', detail: `missing input: ${fixture.inputPath}` };
	if (!existsSync(truthPath)) return { ...fixture, status: 'BLOCKED', detail: `missing truth: ${fixture.truthPath}` };
	const truth = loadNumberTruth(truthPath);

	// Qualification deliberately exposes no per-fixture detector configuration.
	// Every image runs the production calibration path with the same global candidate ceiling.
	const result = await runTeeDetection({
		inputPath,
		mode: 'fused',
		outputDir: join(outputRoot, fixture.id),
		templateDir,
		maxCandidates: 18,
		ignoreCirclesPx: []
	});
	const detection = result.numberDetection;
	if (!detection) return { ...fixture, status: 'FAIL', detail: 'number detector produced no numberDetection result' };
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

	return {
		...fixture,
		status: errors.length === 0 ? 'PASS' : 'FAIL',
		detail: errors.length === 0
			? `${truth.badges.length}/${truth.badges.length} labels; max center error ${maxCenterErrorPx.toFixed(2)}px`
			: errors.join('; '),
		metrics: {
			expected: truth.badges.length,
			candidates: detection.candidateCount,
			labeled: detection.labeledCount,
			maxCenterErrorPx,
			uiScalePx: result.uiScalePx
		}
	};
}

async function evaluateBaskets(
	fixture: GalleryCase,
	manifest: GalleryManifest,
	outputRoot: string
): Promise<CaseResult> {
	const inputPath = repoPath(fixture.inputPath, `${fixture.id}.inputPath`);
	if (!existsSync(inputPath)) return { ...fixture, status: 'BLOCKED', detail: `missing input: ${fixture.inputPath}` };
	const result = await runBasketDetection({
		inputPath,
		outputDir: join(outputRoot, fixture.id),
		templateDir,
		maxCandidates: 18
	});
	if (!result.truthEvaluation) {
		return { ...fixture, status: 'BLOCKED', detail: 'basket case has no localization truth evaluation' };
	}
	const matched = result.truthEvaluation.matchedNumbers.length;
	const falsePositives = result.truthEvaluation.falsePositiveCount;
	const errors: string[] = [];
	if (result.candidateCount !== manifest.policy.baskets.requiredMatched) {
		errors.push(`candidates=${result.candidateCount}, expected ${manifest.policy.baskets.requiredMatched}`);
	}
	if (matched !== manifest.policy.baskets.requiredMatched) {
		errors.push(`localized=${matched}/${manifest.policy.baskets.requiredMatched}`);
	}
	if (falsePositives > manifest.policy.baskets.maxFalsePositives) {
		errors.push(`false positives=${falsePositives}, max ${manifest.policy.baskets.maxFalsePositives}`);
	}
	return {
		...fixture,
		status: errors.length === 0 ? 'PASS' : 'FAIL',
		detail: errors.length === 0
			? `${matched}/${manifest.policy.baskets.requiredMatched} localized; ${falsePositives} FP; association NOT evaluated`
			: `${errors.join('; ')}; association NOT evaluated`,
		metrics: { matched, falsePositives, candidateCount: result.candidateCount, associationEvaluated: false }
	};
}

function coverageFailures(manifest: GalleryManifest): CaseResult[] {
	const results: CaseResult[] = [];
	for (const detector of ['numbers', 'baskets', 'tees'] as const) {
		if (!enabled(manifest, detector)) continue;
		const active = manifest.cases.filter((fixture) => fixture.detector === detector && fixture.status === 'active');
		for (const resolutionClass of manifest.policy.requiredResolutionClasses) {
			if (!active.some((fixture) => fixture.resolutionClass === resolutionClass)) {
				results.push({
					id: `${detector}-coverage-${resolutionClass}`,
					detector,
					resolutionClass,
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
		.map((fixture) => ({
			id: fixture.id,
			detector: fixture.detector,
			resolutionClass: fixture.resolutionClass,
			status: 'BLOCKED' as const,
			detail: fixture.note ?? 'fixture is pending manually verified truth'
		}));
}

function printResults(results: readonly CaseResult[], manifest: GalleryManifest): void {
	console.log('CV QUALIFICATION');
	console.log('');
	for (const detector of ['numbers', 'baskets', 'tees'] as const) {
		console.log(detector.toUpperCase() + (detector === 'baskets' ? ' — LOCALIZATION ONLY' : ''));
		if (!enabled(manifest, detector)) {
			console.log(`SKIP  ${manifest.policy[detector].reason ?? 'gate disabled'}`);
			console.log('');
			continue;
		}
		const detectorResults = results.filter((result) => result.detector === detector);
		for (const result of detectorResults) {
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

async function main(): Promise<void> {
	const galleryArg = process.argv.indexOf('--gallery');
	const galleryPath = galleryArg >= 0
		? resolve(process.argv[galleryArg + 1] ?? fail('--gallery requires a path'))
		: defaultGalleryPath;
	if (!existsSync(galleryPath)) fail(`CV gallery manifest does not exist: ${galleryPath}`);
	const manifest = parseManifest(galleryPath);
	loadValidatedCvTemplateManifest(templateDir);
	const outputRoot = mkdtempSync(join(tmpdir(), 'chainspot-cv-gallery-'));
	const results: CaseResult[] = [];
	try {
		for (const fixture of manifest.cases) {
			if (fixture.status !== 'active' || !enabled(manifest, fixture.detector)) continue;
			try {
				if (fixture.detector === 'numbers') results.push(await evaluateNumbers(fixture, manifest, outputRoot));
				else if (fixture.detector === 'baskets') results.push(await evaluateBaskets(fixture, manifest, outputRoot));
			} catch (error) {
				results.push({
					id: fixture.id,
					detector: fixture.detector,
					resolutionClass: fixture.resolutionClass,
					status: 'FAIL',
					detail: error instanceof Error ? error.message : String(error)
				});
			}
		}
		results.push(...pendingFailures(manifest));
		results.push(...coverageFailures(manifest));
		printResults(results, manifest);
		if (process.argv.includes('--json')) console.log(JSON.stringify({ manifest: galleryPath, results }, null, 2));
		if (results.some((result) => result.status !== 'PASS')) process.exitCode = 1;
	} finally {
		rmSync(outputRoot, { recursive: true, force: true });
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
