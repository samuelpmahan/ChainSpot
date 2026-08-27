import { mkdirSync, writeFileSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import {
	DEFAULT_CORPUS_ROOT,
	REPO_ROOT,
	listCourseManifests,
	loadLabConfig,
	type ResolvedLabCourseManifest
} from '../context/context.mjs';
import { runSweepOperation, type RunSweepOperationResult } from './operation';
import { isSweepThroughGate, type SweepThroughGate } from './gateVocabulary';
import { loadConfig as loadSweepConfig } from './configIo';

export interface SweepCase {
	readonly name: string;
	readonly inputs: readonly string[];
}

export interface BatchManifest extends ResolvedLabCourseManifest {
	readonly set?: string;
	readonly corpusDir?: string;
	readonly sweepCases?: readonly SweepCase[];
}

export interface BatchRow {
	readonly course: string;
	readonly caseName: string;
	readonly inputs: readonly string[];
	readonly status: 'ok' | 'failed';
	readonly outDir: string;
	readonly badges?: number;
	readonly baskets?: number;
	readonly rawRings?: number;
	readonly preFamilyTees?: number;
	readonly visibleTees?: number;
	readonly visibleDeficit?: number;
	readonly provenance?: {
		readonly badges: string;
		readonly baskets: string;
		readonly rawRings: string;
		readonly preFamilyTees: string;
		readonly visibleTees: string;
		readonly visibleDeficit: string;
		readonly operations: string;
		readonly durationMs: string;
		readonly conformanceDrift: string;
	};
	readonly operations?: number;
	readonly durationMs?: number;
	readonly conformanceDrift?: number;
	readonly error?: string;
}

export interface BatchSummary {
	readonly configName: string;
	readonly configPath: string;
	readonly throughGate: SweepThroughGate;
	readonly selectors: readonly string[];
	readonly rows: readonly BatchRow[];
	readonly succeeded: number;
	readonly failed: number;
	readonly status: 'ok' | 'failed';
}

function normalized(value: unknown): string {
	return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function initials(value: unknown): string {
	return String(value ?? '')
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/[^a-zA-Z0-9]+/g, ' ')
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.map((word) => word[0])
		.join('')
		.toLowerCase();
}

function manifestTokens(manifest: BatchManifest): Set<string> {
	return new Set(
		[manifest.course, manifest.devDir, ...(manifest.aliases ?? []), initials(manifest.course), initials(manifest.devDir)]
			.map(normalized)
			.filter(Boolean)
	);
}

/** Resolve set names and course aliases without consulting detector output. */
export function selectBatchManifests(
	selectors: readonly string[],
	manifests: readonly ResolvedLabCourseManifest[] = listCourseManifests()
): readonly BatchManifest[] {
	const requested = selectors.length ? selectors : ['dev'];
	const selected: BatchManifest[] = [];
	const add = (manifest: BatchManifest): void => {
		if (!selected.some((entry) => entry.path === manifest.path)) selected.push(manifest);
	};
	for (const selector of requested) {
		const key = normalized(selector);
		if (key === 'all') {
			for (const manifest of manifests) add(manifest as BatchManifest);
			continue;
		}
		if (key === 'dev' || key === 'demo') {
			for (const manifest of manifests) {
				const set = normalized((manifest as BatchManifest).set ?? 'dev');
				if (set === key) add(manifest as BatchManifest);
			}
			continue;
		}
		const exact = manifests.filter((manifest) => manifestTokens(manifest as BatchManifest).has(key));
		const prefix = exact.length
			? exact
			: manifests.filter((manifest) => [...manifestTokens(manifest as BatchManifest)].some((token) => token.startsWith(key)));
		if (prefix.length === 0) {
			throw new Error(`lab sweep batch: unknown selector '${selector}'. Try dev, demo, all, or a course alias.`);
		}
		if (prefix.length > 1) {
			throw new Error(`lab sweep batch: selector '${selector}' is ambiguous: ${prefix.map((manifest) => manifest.course).join(', ')}`);
		}
		add(prefix[0] as BatchManifest);
	}
	if (selected.length === 0) throw new Error(`lab sweep batch: selectors matched no course manifests.`);
	return selected;
}

export function casesForManifest(manifest: BatchManifest): readonly SweepCase[] {
	if (manifest.sweepCases?.length) return manifest.sweepCases;
	if (!manifest.image) throw new Error(`lab sweep batch: manifest '${manifest.course}' has no image.`);
	return [{ name: 'full', inputs: [manifest.image] }];
}

export function resolveBatchCaseInputs(
	manifest: BatchManifest,
	corpusRoot: string,
	entry: SweepCase
): readonly string[] {
	if (!entry.name.trim()) throw new Error(`lab sweep batch: ${manifest.course} has a case with an empty name.`);
	if (!entry.inputs.length) throw new Error(`lab sweep batch: ${manifest.course}/${entry.name} has no inputs.`);
	const courseDir = resolve(corpusRoot, manifest.corpusDir ?? 'dev', manifest.devDir);
	return entry.inputs.map((input) => resolve(courseDir, input));
}

function safeSegment(value: string): string {
	return value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed';
}

function relativeOutputPath(path: string): string {
	return relative(REPO_ROOT, path).split('\\').join('/');
}

function unitAccepted(result: RunSweepOperationResult, id: string): number | undefined {
	const unit = result.trace.units.find((candidate) => candidate.id === id);
	return unit?.drawables.filter((drawable) => drawable.verdict === 'accepted').length;
}

function unitExamined(result: RunSweepOperationResult, id: string): number | undefined {
	const unit = result.trace.units.find((candidate) => candidate.id === id);
	return unit?.drawables.filter(
		(drawable) => drawable.verdict === 'accepted' || drawable.verdict === 'rejected'
	).length;
}

function conformanceDrift(result: RunSweepOperationResult): number {
	return result.receipts.filter((receipt) => {
		const consumes = new Set(receipt.actualConsumes);
		const produces = new Set(receipt.actualProduces);
		return receipt.declaredConsumes.some((slot) => !consumes.has(slot)) || receipt.declaredProduces.some((slot) => !produces.has(slot));
	}).length;
}

export function summarizeBatchSuccess(
	manifest: BatchManifest,
	entry: SweepCase,
	inputs: readonly string[],
	result: RunSweepOperationResult,
	outDir: string
): BatchRow {
	const badges = unitAccepted(result, 'badges');
	const preFamilyTees = unitAccepted(result, 'tees');
	const visibleTees = unitAccepted(result, 'teeFamily');
	return {
		course: manifest.course,
		caseName: entry.name,
		inputs: inputs.map(relativeOutputPath),
		status: 'ok',
		outDir: relativeOutputPath(outDir),
		badges,
		baskets: unitAccepted(result, 'baskets'),
		rawRings: unitExamined(result, 'tees'),
		preFamilyTees,
		visibleTees,
		visibleDeficit:
			badges === undefined || visibleTees === undefined
				? undefined
				: Math.max(0, badges - visibleTees),
		provenance: {
			badges: "trace unit 'badges' accepted drawables",
			baskets: "trace unit 'baskets' accepted drawables",
			rawRings: "trace unit 'tees' accepted + rejected drawables (ringMeasure/exclusion)",
			preFamilyTees: "trace unit 'tees' accepted drawables after G3 exclusion",
			visibleTees: "trace unit 'teeFamily' accepted drawables",
			visibleDeficit: "max(0, trace unit 'badges' accepted drawables - visibleTees)",
			operations: 'engine operation receipt count',
			durationMs: 'sum of engine operation receipt durationMs values (volatile run measurement)',
			conformanceDrift: 'engine receipts missing any declared consume/produce slot from actual consumes/produces'
		},
		operations: result.receipts.length,
		durationMs: Number(result.receipts.reduce((sum, receipt) => sum + receipt.durationMs, 0).toFixed(3)),
		conformanceDrift: conformanceDrift(result)
	};
}

export function summarizeBatchFailure(
	manifest: BatchManifest,
	entry: SweepCase,
	inputs: readonly string[],
	outDir: string,
	error: unknown
): BatchRow {
	return {
		course: manifest.course,
		caseName: entry.name,
		inputs: inputs.map(relativeOutputPath),
		status: 'failed',
		outDir: relativeOutputPath(outDir),
		error: error instanceof Error ? error.message : String(error)
	};
}

function textRow(row: BatchRow): string {
	if (row.status === 'failed') return `${row.course} · ${row.caseName} · FAIL · ${row.error}`;
	return [
		row.course,
		row.caseName,
		`${row.inputs.length} input${row.inputs.length === 1 ? '' : 's'}`,
		`badges=${row.badges ?? 'UNKNOWN'}`,
		`baskets=${row.baskets ?? 'UNKNOWN'}`,
		`rawRings=${row.rawRings ?? 'UNKNOWN'}`,
		`preFamilyTees=${row.preFamilyTees ?? 'UNKNOWN'}`,
		`visibleTees=${row.visibleTees ?? 'UNKNOWN'}`,
		`visibleDeficit=${row.visibleDeficit ?? 'UNKNOWN'}`,
		`ops=${row.operations ?? 'UNKNOWN'}`,
		`ms=${row.durationMs ?? 'UNKNOWN'}`,
		`drift=${row.conformanceDrift ?? 'UNKNOWN'}`,
		'OK'
	].join(' · ');
}

export function renderBatchText(summary: BatchSummary): string {
	const provenance = summary.rows.find((row) => row.provenance)?.provenance;
	return [
		`LAB SWEEP BATCH — ${summary.configName}`,
		`through: ${summary.throughGate}`,
		`selectors: ${summary.selectors.join(', ')}`,
		'',
		'course · case · inputs · badges · baskets · rawRings · preFamilyTees · visibleTees · visibleDeficit · ops · ms · drift · status',
		...summary.rows.map(textRow),
		'',
		'metric provenance:',
		`  badges: ${provenance?.badges ?? 'UNKNOWN'}`,
		`  baskets: ${provenance?.baskets ?? 'UNKNOWN'}`,
		`  rawRings: ${provenance?.rawRings ?? 'UNKNOWN'}`,
		`  preFamilyTees: ${provenance?.preFamilyTees ?? 'UNKNOWN'}`,
		`  visibleTees: ${provenance?.visibleTees ?? 'UNKNOWN'}`,
		`  visibleDeficit: ${provenance?.visibleDeficit ?? 'UNKNOWN'}`,
		`  ops: ${provenance?.operations ?? 'UNKNOWN'}`,
		`  ms: ${provenance?.durationMs ?? 'UNKNOWN'}`,
		`  drift: ${provenance?.conformanceDrift ?? 'UNKNOWN'}`,
		'',
		`summary: ${summary.succeeded} succeeded · ${summary.failed} failed · status=${summary.status}`
	].join('\n') + '\n';
}

export function parseBatchArgs(args: readonly string[]): { throughGate: SweepThroughGate; configPath: string; selectors: readonly string[] } {
	const rest = [...args];
	let throughGate: SweepThroughGate = 'G3';
	const throughIndex = rest.indexOf('--through');
	if (throughIndex >= 0) {
		const value = rest[throughIndex + 1];
		if (!value || !isSweepThroughGate(value)) throw new Error(`lab sweep batch: --through requires a gate such as G1, G2, or G3.`);
		throughGate = value;
		rest.splice(throughIndex, 2);
	}
	if (!rest.length || rest[0] !== 'batch') throw new Error('lab sweep batch: expected batch CONFIG.json [dev|demo|all|COURSE]...');
	const configPath = rest[1];
	if (!configPath || extname(configPath).toLowerCase() !== '.json') throw new Error('lab sweep batch: CONFIG.json is required.');
	return { throughGate, configPath, selectors: rest.slice(2) };
}

export async function runSweepBatch(args: readonly string[]): Promise<number> {
	const parsed = parseBatchArgs(args);
	const config = compileConfigForBatch(parsed.configPath);
	const manifests = selectBatchManifests(parsed.selectors);
	const labConfig = loadLabConfig();
	const corpusRoot = resolve(labConfig.corpusRoot ?? DEFAULT_CORPUS_ROOT);
	const batchRoot = resolve(REPO_ROOT, 'artifacts', 'sweep', safeSegment(config.configName), 'batches');
	const rows: BatchRow[] = [];
	const work = manifests.flatMap((manifest) =>
		casesForManifest(manifest).map((entry) => ({ manifest, entry }))
	);
	for (const [index, { manifest, entry }] of work.entries()) {
		const progress = `LAB SWEEP BATCH [${index + 1}/${work.length}]`;
		const outDir = resolve(batchRoot, safeSegment(manifest.course), safeSegment(entry.name));
		let inputs: readonly string[] = [];
		console.log(`${progress} START ${manifest.course}/${entry.name} · inputs=${entry.inputs.length}`);
		try {
			inputs = resolveBatchCaseInputs(manifest, corpusRoot, entry);
			// A normal sweep prints every renderer/feature receipt. Batch owns a
			// compact aggregate surface, so keep those per-case details on disk.
			const log = console.log;
			console.log = () => undefined;
			let result: RunSweepOperationResult;
			try {
				result = await runSweepOperation({ configPath: parsed.configPath, inputPaths: inputs, outDir, throughGate: parsed.throughGate });
			} finally {
				console.log = log;
			}
			rows.push(summarizeBatchSuccess(manifest, entry, inputs, result, outDir));
			console.log(`${progress} DONE ${manifest.course}/${entry.name}`);
		} catch (error) {
			rows.push(summarizeBatchFailure(manifest, entry, inputs, outDir, error));
			console.log(`${progress} FAIL ${manifest.course}/${entry.name}`);
		}
	}
	const failed = rows.filter((row) => row.status === 'failed').length;
	const summary: BatchSummary = {
		configName: config.configName,
		configPath: relativeOutputPath(resolve(parsed.configPath)),
		throughGate: parsed.throughGate,
		selectors: parsed.selectors.length ? parsed.selectors : ['dev'],
		rows,
		succeeded: rows.length - failed,
		failed,
		status: failed ? 'failed' : 'ok'
	};
	mkdirSync(batchRoot, { recursive: true });
	writeFileSync(resolve(batchRoot, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
	writeFileSync(resolve(batchRoot, 'summary.txt'), renderBatchText(summary));
	console.log(renderBatchText(summary).trimEnd());
	console.log(`receipts: ${relativeOutputPath(resolve(batchRoot, 'summary.txt'))}, ${relativeOutputPath(resolve(batchRoot, 'summary.json'))}`);
	return failed ? 1 : 0;
}

function compileConfigForBatch(configPath: string): { configName: string } {
	const { resolved } = loadSweepConfig(configPath);
	return { configName: resolved.name };
}
