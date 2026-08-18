/**
 * Importable core of the headless, config-driven Pancake CV replay runner.
 *
 * This module holds the machinery `scripts/cv-replay-run.ts` used to run
 * entirely inline (image loading, template-pack loading, truth loading, and
 * driving `runPancakePipeline`), refactored out so both the CLI and the Toph
 * replay adapter (`scripts/toph-replay-adapter.ts`) can import and reuse it
 * without duplicating logic. The CLI (`cv-replay-run.ts`) is a thin wrapper
 * around `runCvReplay` below; its behavior/output is unchanged.
 */
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { loadCv } from '../../src/lib/stitch/cvMatch';
import { runPancakePipeline } from '../../src/lib/autoAnnotation/cvPipeline';
import type { PancakeInput, PancakeResult, PancakeObserver } from '../../src/lib/autoAnnotation/cvPipeline';
import type { ChainSpotCvConfig } from '../../src/lib/autoAnnotation/cvConfig';
import { validateCvTemplateManifest } from '../../src/lib/autoAnnotation/cvCalibration';
import type { CvTemplateManifest } from '../../src/lib/autoAnnotation/cvCalibration';
import type { HoleNumberTemplate } from '../../src/lib/autoAnnotation/holeNumberDetection';
import { score } from '../../src/lib/autoAnnotation/p6AssignmentScoring';
import type { P6AssignmentScore, TruthHole } from '../../src/lib/autoAnnotation/p6AssignmentScoring';
import { decodeImageBuffer, contentTypeFor } from './fakeBrowser';

export interface LoadedCvImage {
	readonly rgba: Uint8ClampedArray;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly fileName: string;
	/** Raw encoded source bytes (the actual file/zip-entry on disk) -- hashed for `sourceIdentity.sha256`. */
	readonly rawBytes: Uint8Array;
	readonly truth?: readonly TruthHole[];
}

export async function loadTemplatePack(
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

export async function loadCvImage(imagePath: string): Promise<LoadedCvImage> {
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

export function loadExternalTruth(truthPath: string | undefined): TruthHole[] | undefined {
	if (!truthPath) return undefined;
	const raw = JSON.parse(readFileSync(resolve(truthPath), 'utf8'));
	// Accept either a bare TruthHole[] or a `the-rec.json`-style fixture with an
	// `observedBehavior.finalAssignments`-shaped section -- the latter has NO
	// independent basket ground truth, so it intentionally does not produce
	// scorable truth here.
	if (Array.isArray(raw)) return raw as TruthHole[];
	return undefined;
}

export function gitRevisionSync(cwd: string): string {
	try {
		return execSync('git rev-parse HEAD', { cwd }).toString().trim();
	} catch {
		return 'unknown';
	}
}

export interface CvReplayContext {
	readonly projectRoot: string;
	readonly image: LoadedCvImage;
	readonly sha256: string;
	readonly pancakeInput: PancakeInput;
	readonly truthHoles?: readonly TruthHole[];
}

/**
 * Loads everything that does not depend on the config: the OpenCV module,
 * the template pack, and the decoded source image. Reusable across many
 * `runCvReplayPipeline` calls against different configs (as a replay/grid
 * session does) without re-decoding the image or re-loading templates each
 * time.
 */
export async function loadCvReplayContext(
	imagePath: string,
	projectRoot: string,
	truthPath?: string
): Promise<CvReplayContext> {
	const resolvedRoot = resolve(projectRoot);
	const image = await loadCvImage(imagePath);
	const sha256 = createHash('sha256').update(image.rawBytes).digest('hex');

	const cv = await loadCv();
	const templatePack = await loadTemplatePack(resolvedRoot);

	const pancakeInput: PancakeInput = {
		cv: cv as unknown as PancakeInput['cv'],
		holeNumberTemplates: templatePack.holeNumbers,
		full: { rgba: image.rgba, widthPx: image.widthPx, heightPx: image.heightPx },
		fullRasterMs: 0
	};

	const externalTruth = loadExternalTruth(truthPath);
	const truthHoles = externalTruth ?? image.truth;

	return { projectRoot: resolvedRoot, image, sha256, pancakeInput, truthHoles };
}

export interface CvReplayRunOutput {
	readonly wallMs: number;
	readonly pipeline: PancakeResult;
	readonly correctness: P6AssignmentScore | null;
}

/** Runs `runPancakePipeline` under `config` against an already-loaded context. Pure w.r.t. `context`. */
export async function runCvReplayPipeline(
	context: CvReplayContext,
	config: ChainSpotCvConfig,
	observer?: PancakeObserver
): Promise<CvReplayRunOutput> {
	const startedAt = Date.now();
	const pipeline = await runPancakePipeline(context.pancakeInput, config, observer);
	const wallMs = Date.now() - startedAt;

	const correctness =
		context.truthHoles && context.truthHoles.length > 0
			? score(pipeline.p6LowParBasketAssignment, pipeline.rawMaskObjects.baskets, context.truthHoles)
			: null;

	return { wallMs, pipeline, correctness };
}
