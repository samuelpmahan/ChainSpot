/**
 * Headless, config-driven replay runner for the Pancake CV pipeline.
 *
 * Runs the REAL production pipeline (`cvPipeline.ts`'s `runPancakePipeline`,
 * the same function `basketDetection.worker.ts` delegates to) against one
 * image or `.chainspot.zip`, with an arbitrary `ChainSpotCvConfig`, entirely
 * in Node. This is the mechanism a counterfactual-replay tool (Toph) drives:
 * grid search and manual parameter toggles both just call this with a
 * different config.
 *
 * Unlike `pancake-harness.ts` (which drives the worker's message protocol
 * end-to-end, including its browser-only OffscreenCanvas plumbing, to prove
 * production parity), this script calls `runPancakePipeline` directly so it
 * can capture per-stage `StageExecutionRecord`s and an arbitrary config --
 * the worker's message protocol has neither. It reuses
 * `scripts/lib/fakeBrowser.ts`'s `decodeImageBuffer` for image decoding
 * rather than duplicating that logic.
 *
 * Usage:
 *   npx tsx scripts/cv-replay-run.ts --image <png/jpg/.chainspot.zip> --project-root . [--config <json file>] [--truth <json file>] [--out <json file>]
 */
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { loadCv } from '../src/lib/stitch/cvMatch';
import { runPancakePipeline } from '../src/lib/autoAnnotation/cvPipeline';
import type { PancakeInput, StageExecutionRecord } from '../src/lib/autoAnnotation/cvPipeline';
import { DEFAULT_CV_CONFIG } from '../src/lib/autoAnnotation/cvConfig';
import type { ChainSpotCvConfig } from '../src/lib/autoAnnotation/cvConfig';
import { validateCvTemplateManifest } from '../src/lib/autoAnnotation/cvCalibration';
import type { CvTemplateManifest } from '../src/lib/autoAnnotation/cvCalibration';
import type { HoleNumberTemplate } from '../src/lib/autoAnnotation/holeNumberDetection';
import { score } from '../src/lib/autoAnnotation/p6AssignmentScoring';
import type { TruthHole } from '../src/lib/autoAnnotation/p6AssignmentScoring';
import { decodeImageBuffer, contentTypeFor } from './lib/fakeBrowser';

interface CliArgs {
	readonly image: string;
	readonly projectRoot: string;
	readonly configPath?: string;
	readonly outPath?: string;
	readonly truthPath?: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
	const get = (flag: string): string | undefined => {
		const index = argv.indexOf(flag);
		return index >= 0 ? argv[index + 1] : undefined;
	};
	const image = get('--image');
	const projectRoot = get('--project-root');
	if (!image || !projectRoot) {
		throw new Error(
			'Usage: npx tsx scripts/cv-replay-run.ts --image <png/jpg/.chainspot.zip> --project-root . [--config <json file>] [--truth <json file>] [--out <json file>]'
		);
	}
	return {
		image,
		projectRoot,
		configPath: get('--config'),
		outPath: get('--out'),
		truthPath: get('--truth')
	};
}

function deepMerge<T>(base: T, patch: unknown): T {
	if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return base;
	const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
		const baseValue = (base as Record<string, unknown>)[key];
		result[key] =
			value !== null && typeof value === 'object' && !Array.isArray(value) && baseValue !== undefined
				? deepMerge(baseValue, value)
				: value;
	}
	return result as T;
}

function loadEffectiveConfig(configPath: string | undefined): ChainSpotCvConfig {
	if (!configPath) return DEFAULT_CV_CONFIG;
	const raw = JSON.parse(readFileSync(resolve(configPath), 'utf8'));
	return deepMerge(DEFAULT_CV_CONFIG, raw);
}

async function loadTemplatePack(
	projectRoot: string
): Promise<{ manifest: CvTemplateManifest; holeNumbers: HoleNumberTemplate[] }> {
	const root = join(projectRoot, 'static/resources/chainspot_cv_templates');
	const manifestPath = join(root, 'manifest.json');
	if (!existsSync(manifestPath)) throw new Error(`CV template manifest is missing: ${manifestPath}`);
	const manifest = validateCvTemplateManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));

	const holeNumbers: HoleNumberTemplate[] = await Promise.all(
		manifest.templates.holeNumbers.map(async (fileName, index) => {
			const path = join(root, fileName);
			const decoded = await decodeImageBuffer(readFileSync(path), contentTypeFor(path));
			return {
				label: index + 1,
				raster: { format: 'rgba' as const, widthPx: decoded.width, heightPx: decoded.height, data: new Uint8Array(decoded.rgba) }
			};
		})
	);
	return { manifest, holeNumbers };
}

interface ProjectDocument {
	readonly holes?: readonly Readonly<{
		number?: unknown;
		basket?: Readonly<{ xPx?: unknown; yPx?: unknown }>;
	}>[];
}

function truthFromProjectDocument(document: ProjectDocument): TruthHole[] {
	return (document.holes ?? [])
		.map((hole) => ({
			number: typeof hole.number === 'number' ? hole.number : NaN,
			basket:
				typeof hole.basket?.xPx === 'number' && typeof hole.basket?.yPx === 'number'
					? { xPx: hole.basket.xPx, yPx: hole.basket.yPx }
					: undefined
		}))
		.filter((hole): hole is TruthHole => Number.isInteger(hole.number) && hole.basket !== undefined)
		.sort((a, b) => a.number - b.number);
}

interface LoadedImage {
	readonly rgba: Uint8ClampedArray;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly fileName: string;
	/** Raw encoded source bytes (the actual file/zip-entry on disk) -- `sourceIdentity.sha256` hashes THIS, not the decoded pixel buffer, so it matches `sha256sum` on the original file. */
	readonly rawBytes: Uint8Array;
	readonly truth?: readonly TruthHole[];
}

async function loadImage(imagePath: string): Promise<LoadedImage> {
	const resolved = resolve(imagePath);
	const bytes = readFileSync(resolved);
	if (extname(resolved).toLowerCase() === '.zip' || resolved.toLowerCase().endsWith('.chainspot.zip')) {
		const entries = unzipSync(new Uint8Array(bytes));
		const sourceBytes = entries['images/source-original.jpg'];
		if (!sourceBytes) throw new Error(`${resolved} has no images/source-original.jpg`);
		const decoded = await decodeImageBuffer(Buffer.from(sourceBytes), 'image/jpeg');
		let truth: TruthHole[] | undefined;
		const projectBytes = entries['project.json'];
		if (projectBytes) {
			const document = JSON.parse(strFromU8(projectBytes)) as ProjectDocument;
			truth = truthFromProjectDocument(document);
		}
		return {
			rgba: decoded.rgba,
			widthPx: decoded.width,
			heightPx: decoded.height,
			fileName: 'source-original.jpg',
			rawBytes: sourceBytes,
			truth
		};
	}
	const decoded = await decodeImageBuffer(Buffer.from(bytes), contentTypeFor(resolved));
	return {
		rgba: decoded.rgba,
		widthPx: decoded.width,
		heightPx: decoded.height,
		fileName: resolved.split('/').pop() ?? resolved,
		rawBytes: new Uint8Array(bytes)
	};
}

function loadExternalTruth(truthPath: string | undefined): TruthHole[] | undefined {
	if (!truthPath) return undefined;
	const raw = JSON.parse(readFileSync(resolve(truthPath), 'utf8'));
	// Accept either a bare TruthHole[] or a `the-rec.json`-style fixture with
	// an `observedBehavior.finalAssignments`-shaped section -- the latter has
	// NO independent basket ground truth (see resources/cv-fixtures/the-rec.json),
	// so it intentionally does not produce scorable truth here.
	if (Array.isArray(raw)) return raw as TruthHole[];
	return undefined;
}

function gitRevisionSync(projectRoot: string): string {
	try {
		return execSync('git rev-parse HEAD', { cwd: projectRoot }).toString().trim();
	} catch {
		return 'unknown';
	}
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const projectRoot = resolve(args.projectRoot);
	const config = loadEffectiveConfig(args.configPath);

	const image = await loadImage(args.image);
	const sha256 = createHash('sha256').update(image.rawBytes).digest('hex');

	const cv = await loadCv();
	const templatePack = await loadTemplatePack(projectRoot);

	const pancakeInput: PancakeInput = {
		cv: cv as unknown as PancakeInput['cv'],
		holeNumberTemplates: templatePack.holeNumbers,
		full: { rgba: image.rgba, widthPx: image.widthPx, heightPx: image.heightPx },
		fullRasterMs: 0
	};

	const stages: StageExecutionRecord[] = [];
	const startedAt = Date.now();
	const pipeline = await runPancakePipeline(pancakeInput, config, (record) => {
		stages.push(record);
	});
	const wallMs = Date.now() - startedAt;

	const externalTruth = loadExternalTruth(args.truthPath);
	const truthHoles = externalTruth ?? image.truth;
	const correctness =
		truthHoles && truthHoles.length > 0
			? score(pipeline.p6LowParBasketAssignment, pipeline.rawMaskObjects.baskets, truthHoles)
			: null;

	const perHoleAssignments = pipeline.p6LowParBasketAssignment.assignments.map((assignment) => {
		const basket =
			assignment.assignedBasketIndex !== null ? pipeline.rawMaskObjects.baskets[assignment.assignedBasketIndex] : undefined;
		return {
			holeNumber: assignment.holeNumber,
			teeIndex: assignment.teeIndex,
			assignedBasketIndex: assignment.assignedBasketIndex,
			basketXPx: basket?.centerXPx ?? null,
			basketYPx: basket?.centerYPx ?? null,
			status: assignment.status,
			assignmentReason: assignment.assignmentReason
		};
	});

	const output = {
		wallMs,
		sourceIdentity: {
			fileName: image.fileName,
			sha256,
			widthPx: image.widthPx,
			heightPx: image.heightPx
		},
		codeVersion: { chainspot: gitRevisionSync(projectRoot) },
		effectiveConfig: config,
		stages,
		p6: pipeline.p6LowParBasketAssignment,
		final: { holes: pipeline.grammar.holes.length },
		perHoleAssignments,
		correctness
	};

	const json = JSON.stringify(output, null, 2);
	if (args.outPath) {
		writeFileSync(resolve(args.outPath), json);
	} else {
		console.log(json);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
