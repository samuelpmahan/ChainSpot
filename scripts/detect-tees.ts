import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { strFromU8, unzipSync } from 'fflate';
import { PNG } from 'pngjs';
import { loadCv } from '../src/lib/stitch/cvMatch';
import {
	detectCalibratedHoleNumberBadges,
	detectCalibratedOccludedEdgeLoopCandidates,
	detectCalibratedTeePadVariants
} from '../src/lib/autoAnnotation/cvCalibratedDetectors';
import type {
	CalibratedHoleNumberDetection,
	CalibratedTeePadDetectionOptions
} from '../src/lib/autoAnnotation/cvCalibratedDetectors';
import {
	asUiScalePx,
	deriveUDiscCalibration,
	validateCvTemplateManifest
} from '../src/lib/autoAnnotation/cvCalibration';
import type {
	CvTemplateManifest,
	UiScalePx
} from '../src/lib/autoAnnotation/cvCalibration';
import type {
	OccludedEdgeLoopResult,
	TeePadCandidate,
	TeePadCv,
	TeePadStageCounts,
	TeePadRaster,
	TeePadVariant,
	TeePadVariantResult
} from '../src/lib/autoAnnotation/teePadDetection';
import type {
	HoleNumberCvModule,
	HoleNumberTemplate
} from '../src/lib/autoAnnotation/holeNumberDetection';

export type TeeCliMode = 'edge-loop' | 'fused' | 'occluded-edge-loop';

export interface TeeCliArgs {
	readonly inputPath: string;
	readonly mode: TeeCliMode;
	readonly outputDir: string;
	readonly templateDir: string;
	/** Raw user input; converted to UiScalePx at the CLI boundary. */
	readonly uiScalePx?: number;
	readonly mapTopPx?: number;
	readonly mapBottomPx?: number;
	readonly maxCandidates: number;
	readonly ignoreCirclesPx: readonly Readonly<{ xPx: number; yPx: number; radiusPx: number }>[];
}

interface DecodedRaster {
	readonly rgba: Uint8Array;
	readonly widthPx: number;
	readonly heightPx: number;
}

export interface TeeTruth {
	readonly number: number;
	readonly xPx: number;
	readonly yPx: number;
}

export interface LoadedInput extends DecodedRaster {
	readonly sourcePath: string;
	readonly sourceEntry?: string;
	readonly truth?: readonly TeeTruth[];
}

interface TeeProjectDocument {
	readonly images?: readonly Readonly<{
		role?: unknown;
		mimeType?: unknown;
		fileName?: unknown;
		bundlePath?: unknown;
	}>[];
	readonly holes?: readonly Readonly<{
		number?: unknown;
		tee?: Readonly<{ xPx?: unknown; yPx?: unknown }>;
	}>[];
}

export interface TeeCliResult {
	readonly mode: TeeCliMode;
	readonly input: {
		readonly path: string;
		readonly sourceEntry?: string;
		readonly widthPx: number;
		readonly heightPx: number;
		readonly sourceScale: number;
	};
	readonly uiScalePx: number;
	readonly mapBoundsPx?: Readonly<{ topPx: number; bottomPx: number }>;
	readonly numberDetection?: {
		readonly labeling: CalibratedHoleNumberDetection['labeling'];
		readonly candidateCount: number;
		readonly labeledCount: number;
		readonly candidates: readonly Readonly<{
			label?: number;
			xPx: number;
			yPx: number;
		}>[];
	};
	readonly stageCounts: TeePadStageCounts;
	readonly candidateCount: number;
	readonly candidates: readonly Readonly<{
		index: number;
		center: { xPx: number; yPx: number };
		widthPx: number;
		heightPx: number;
		orientationDeg: number;
		score: number;
		support: readonly string[];
		source: string;
	}>[];
	readonly truthEvaluation?: {
		readonly tolerancePx: number;
		readonly truthCount: number;
		readonly matchedNumbers: readonly number[];
		readonly missedNumbers: readonly number[];
		readonly falsePositiveCount: number;
		readonly falsePositives: readonly Readonly<{ xPx: number; yPx: number; score: number }>[];
	};
	readonly overlayPath: string;
}

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), '..');
const defaultTemplateDir = join(projectRoot, 'static', 'resources', 'chainspot_cv_templates');

function usage(): string {
	return [
		'Usage: npm run detect:tees -- <image-or-chainspot-zip> --mode <edge-loop|fused|occluded-edge-loop> --out <directory>',
		'',
		'Options:',
		'  --templates <directory>       CV template pack (default: static/resources/chainspot_cv_templates)',
		'  --ui-scale <source-pixels>   Override calibrated UDisc UI scale',
		'  --map-top <source-pixels>    Restrict detection to this source row',
		'  --map-bottom <source-pixels> Restrict detection to this source row',
		'  --max-candidates <count>     Candidate limit (default: 18)',
		'  --ignore-circle x,y,r         Clear Canny pixels in a local circle (OEL only; repeatable)',
		'  --help'
	].join('\n');
}

function requireValue(argv: readonly string[], index: number, option: string): string {
	const value = argv[index + 1];
	if (!value || value.startsWith('--')) throw new Error(`${option} requires a value.\n\n${usage()}`);
	return value;
}

function finiteNumber(value: string, option: string): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) throw new Error(`${option} must be a finite number.`);
	return parsed;
}

function parseCircle(value: string): Readonly<{ xPx: number; yPx: number; radiusPx: number }> {
	const parts = value.split(',').map(Number);
	if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part)) || parts[2] <= 0) {
		throw new Error(`--ignore-circle expects x,y,r with a positive radius; received '${value}'.`);
	}
	return { xPx: parts[0], yPx: parts[1], radiusPx: parts[2] };
}

export function parseArgs(argv: readonly string[]): TeeCliArgs {
	if (argv.includes('--help')) throw new Error(usage());
	const positional = argv.find((value) => !value.startsWith('--'));
	if (!positional) throw new Error(`An image or .chainspot.zip input is required.\n\n${usage()}`);
	let mode: TeeCliMode | undefined;
	let outputDir: string | undefined;
	let templateDir = defaultTemplateDir;
	let uiScalePx: number | undefined;
	let mapTopPx: number | undefined;
	let mapBottomPx: number | undefined;
	let maxCandidates = 18;
	const ignoreCirclesPx: Array<Readonly<{ xPx: number; yPx: number; radiusPx: number }>> = [];

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (!argument.startsWith('--')) continue;
		switch (argument) {
			case '--mode': {
				const value = requireValue(argv, index, argument) as TeeCliMode;
				if (value !== 'edge-loop' && value !== 'fused' && value !== 'occluded-edge-loop') {
					throw new Error(`Unsupported --mode '${value}'.\n\n${usage()}`);
				}
				mode = value;
				index += 1;
				break;
			}
			case '--out':
				outputDir = requireValue(argv, index, argument);
				index += 1;
				break;
			case '--templates':
				templateDir = requireValue(argv, index, argument);
				index += 1;
				break;
			case '--ui-scale':
				uiScalePx = finiteNumber(requireValue(argv, index, argument), argument);
				index += 1;
				break;
			case '--map-top':
				mapTopPx = finiteNumber(requireValue(argv, index, argument), argument);
				index += 1;
				break;
			case '--map-bottom':
				mapBottomPx = finiteNumber(requireValue(argv, index, argument), argument);
				index += 1;
				break;
			case '--max-candidates':
				maxCandidates = finiteNumber(requireValue(argv, index, argument), argument);
				index += 1;
				if (!Number.isInteger(maxCandidates) || maxCandidates < 1) throw new Error('--max-candidates must be a positive integer.');
				break;
			case '--ignore-circle':
				ignoreCirclesPx.push(parseCircle(requireValue(argv, index, argument)));
				index += 1;
				break;
			default:
				throw new Error(`Unknown option '${argument}'.\n\n${usage()}`);
		}
	}
	if (!mode) throw new Error(`--mode is required.\n\n${usage()}`);
	if (!outputDir) throw new Error(`--out is required.\n\n${usage()}`);
	if (mapTopPx !== undefined && mapBottomPx !== undefined && mapTopPx > mapBottomPx) throw new Error('--map-top cannot be greater than --map-bottom.');
	if ((mapTopPx === undefined) !== (mapBottomPx === undefined)) throw new Error('--map-top and --map-bottom must be provided together.');
	if (ignoreCirclesPx.length > 0 && mode !== 'occluded-edge-loop') throw new Error('--ignore-circle is only valid with --mode occluded-edge-loop.');
	return { inputPath: positional, mode, outputDir, templateDir, uiScalePx, mapTopPx, mapBottomPx, maxCandidates, ignoreCirclesPx };
}

function decodeRaster(bytes: Uint8Array, fileName: string): DecodedRaster {
	const extension = extname(fileName).toLowerCase();
	if (extension === '.png') {
		const decoded = PNG.sync.read(Buffer.from(bytes));
		return { rgba: new Uint8Array(decoded.data), widthPx: decoded.width, heightPx: decoded.height };
	}
	if (extension === '.jpg' || extension === '.jpeg') {
		const decoded = jpeg.decode(Buffer.from(bytes), { useTArray: true });
		return { rgba: new Uint8Array(decoded.data), widthPx: decoded.width, heightPx: decoded.height };
	}
	throw new Error(`Unsupported image format '${extension}'. Use PNG, JPEG, or a .chainspot.zip bundle.`);
}

function truthFromDocument(document: TeeProjectDocument): readonly TeeTruth[] {
	return (document.holes ?? [])
		.map((hole) => ({
			number: typeof hole.number === 'number' ? hole.number : NaN,
			xPx: typeof hole.tee?.xPx === 'number' ? hole.tee.xPx : NaN,
			yPx: typeof hole.tee?.yPx === 'number' ? hole.tee.yPx : NaN
		}))
		.filter((hole) => Number.isInteger(hole.number) && Number.isFinite(hole.xPx) && Number.isFinite(hole.yPx))
		.sort((a, b) => a.number - b.number);
}

export function loadInput(inputPath: string): LoadedInput {
	const resolvedInput = resolve(inputPath);
	const bytes = new Uint8Array(readFileSync(resolvedInput));
	if (!resolvedInput.toLowerCase().endsWith('.chainspot.zip')) return { ...decodeRaster(bytes, resolvedInput), sourcePath: resolvedInput };
	const entries = unzipSync(bytes);
	const jsonBytes = entries['project.json'];
	if (!jsonBytes) throw new Error(`Bundle '${resolvedInput}' does not contain project.json.`);
	const document = JSON.parse(strFromU8(jsonBytes)) as TeeProjectDocument;
	const sourceManifest = (document.images ?? []).find((image) => image.role === 'source-overview');
	const sourceEntry = sourceManifest?.bundlePath;
	if (typeof sourceEntry !== 'string' || !sourceEntry.startsWith('images/')) throw new Error(`Bundle '${resolvedInput}' does not contain a safe source-overview image path.`);
	const sourceBytes = entries[sourceEntry];
	if (!sourceBytes) throw new Error(`Bundle '${resolvedInput}' is missing ${sourceEntry}.`);
	return {
		...decodeRaster(sourceBytes, typeof sourceManifest?.fileName === 'string' ? sourceManifest.fileName : sourceEntry),
		sourcePath: resolvedInput,
		sourceEntry,
		truth: truthFromDocument(document)
	};
}

export function loadValidatedTemplateManifest(templateDir: string): CvTemplateManifest {
	const root = resolve(templateDir);
	const manifestPath = join(root, 'manifest.json');
	if (!existsSync(manifestPath)) throw new Error(`CV template manifest is missing: ${manifestPath}`);
	const manifest = validateCvTemplateManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
	for (const fileName of [...manifest.templates.holeNumbers, manifest.templates.basket]) {
		const assetPath = join(root, fileName);
		if (!existsSync(assetPath)) throw new Error(`CV template manifest asset is missing: ${assetPath}`);
	}
	return manifest;
}

export function loadNumberTemplates(templateDir: string, manifest: CvTemplateManifest): readonly HoleNumberTemplate[] {
	return manifest.templates.holeNumbers.map((fileName, index) => {
		const label = index + 1;
		const path = join(resolve(templateDir), fileName);
		const decoded = decodeRaster(new Uint8Array(readFileSync(path)), path);
		return {
			label,
			raster: { format: 'rgba', widthPx: decoded.widthPx, heightPx: decoded.heightPx, data: decoded.rgba }
		};
	});
}

function deriveMapBounds(candidates: readonly { readonly yPx: number }[], heightPx: number): Readonly<{ topPx: number; bottomPx: number }> | undefined {
	if (candidates.length < 3) return undefined;
	const ys = candidates.map((candidate) => candidate.yPx);
	const minY = Math.min(...ys);
	const maxY = Math.max(...ys);
	const margin = Math.max(80, Math.min(300, (maxY - minY) * 0.3));
	return { topPx: Math.max(0, minY - margin), bottomPx: Math.min(heightPx, maxY + margin) };
}

interface DetectionInputs {
	readonly uiScalePx: UiScalePx;
	readonly mapBoundsPx?: Readonly<{ topPx: number; bottomPx: number }>;
	readonly numberDetection?: CalibratedHoleNumberDetection;
}

async function deriveDetectionInputs(cv: TeePadCv, raster: DecodedRaster, args: TeeCliArgs): Promise<DetectionInputs> {
	const manifest = loadValidatedTemplateManifest(args.templateDir);
	const explicitBounds = args.mapTopPx !== undefined && args.mapBottomPx !== undefined
		? { topPx: args.mapTopPx, bottomPx: args.mapBottomPx }
		: undefined;
	if (args.uiScalePx !== undefined) {
		return { uiScalePx: asUiScalePx(args.uiScalePx, 'CLI --ui-scale'), mapBoundsPx: explicitBounds };
	}
	const detection = detectCalibratedHoleNumberBadges(
		cv as unknown as HoleNumberCvModule,
		{ format: 'rgba', widthPx: raster.widthPx, heightPx: raster.heightPx, data: raster.rgba },
		loadNumberTemplates(args.templateDir, manifest)
	);
	if (!detection.anchor) throw new Error(detection.note ?? 'Could not derive UI scale from hole-number templates; pass --ui-scale.');
	const calibration = deriveUDiscCalibration(detection.anchor, manifest.calibration.canonicalNumberBadge);
	return {
		uiScalePx: calibration.uiScalePx,
		mapBoundsPx: explicitBounds ?? deriveMapBounds(detection.candidates, raster.heightPx),
		numberDetection: detection
	};
}

function candidateOutput(candidate: TeePadCandidate, index: number): TeeCliResult['candidates'][number] {
	return {
		index,
		center: { xPx: candidate.xPx, yPx: candidate.yPx },
		widthPx: candidate.widthPx,
		heightPx: candidate.heightPx,
		orientationDeg: candidate.orientationDeg,
		score: candidate.score,
		support: candidate.support,
		source: candidate.support.join('+')
	};
}

export function evaluateTruth(truth: readonly TeeTruth[], candidates: readonly TeePadCandidate[], tolerancePx: number): NonNullable<TeeCliResult['truthEvaluation']> {
	const used = new Set<number>();
	const matchedNumbers: number[] = [];
	for (const expected of truth) {
		let bestIndex = -1;
		let bestDistance = Number.POSITIVE_INFINITY;
		for (let index = 0; index < candidates.length; index += 1) {
			if (used.has(index)) continue;
			const candidate = candidates[index];
			const distance = Math.hypot(candidate.xPx - expected.xPx, candidate.yPx - expected.yPx);
			if (distance < bestDistance) { bestDistance = distance; bestIndex = index; }
		}
		if (bestIndex >= 0 && bestDistance <= tolerancePx) { used.add(bestIndex); matchedNumbers.push(expected.number); }
	}
	const missedNumbers = truth.map((expected) => expected.number).filter((number) => !matchedNumbers.includes(number));
	const falsePositives = candidates
		.map((candidate, index) => ({ candidate, index }))
		.filter(({ index }) => !used.has(index))
		.map(({ candidate }) => ({ xPx: candidate.xPx, yPx: candidate.yPx, score: candidate.score }));
	return { tolerancePx, truthCount: truth.length, matchedNumbers, missedNumbers, falsePositiveCount: falsePositives.length, falsePositives };
}

function setPixel(png: PNG, x: number, y: number, color: readonly [number, number, number, number]): void {
	if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
	const offset = (y * png.width + x) * 4;
	png.data[offset] = color[0]; png.data[offset + 1] = color[1]; png.data[offset + 2] = color[2]; png.data[offset + 3] = color[3];
}

function line(png: PNG, x0: number, y0: number, x1: number, y1: number, color: readonly [number, number, number, number]): void {
	let x = Math.round(x0); let y = Math.round(y0);
	const targetX = Math.round(x1); const targetY = Math.round(y1);
	const dx = Math.abs(targetX - x); const dy = Math.abs(targetY - y);
	const stepX = x < targetX ? 1 : -1; const stepY = y < targetY ? 1 : -1;
	let error = dx - dy;
	while (true) {
		setPixel(png, x, y, color);
		if (x === targetX && y === targetY) break;
		const doubled = 2 * error;
		if (doubled > -dy) { error -= dy; x += stepX; }
		if (doubled < dx) { error += dx; y += stepY; }
	}
}

function overlay(raster: DecodedRaster, candidates: readonly TeePadCandidate[], mode: TeeCliMode): Buffer {
	const png = new PNG({ width: raster.widthPx, height: raster.heightPx });
	png.data.set(raster.rgba);
	const color: readonly [number, number, number, number] = mode === 'edge-loop' ? [255, 64, 64, 255] : mode === 'fused' ? [64, 128, 255, 255] : [255, 32, 220, 255];
	for (const candidate of candidates) {
		const angle = (candidate.orientationDeg * Math.PI) / 180;
		const ux = Math.cos(angle); const uy = Math.sin(angle); const nx = -uy; const ny = ux;
		const halfWidth = candidate.widthPx * 0.5; const halfHeight = candidate.heightPx * 0.5;
		const corners = [
			[candidate.xPx + ux * halfWidth + nx * halfHeight, candidate.yPx + uy * halfWidth + ny * halfHeight],
			[candidate.xPx - ux * halfWidth + nx * halfHeight, candidate.yPx - uy * halfWidth + ny * halfHeight],
			[candidate.xPx - ux * halfWidth - nx * halfHeight, candidate.yPx - uy * halfWidth - ny * halfHeight],
			[candidate.xPx + ux * halfWidth - nx * halfHeight, candidate.yPx + uy * halfWidth - ny * halfHeight]
		] as const;
		for (let index = 0; index < corners.length; index += 1) {
			const first = corners[index]; const second = corners[(index + 1) % corners.length];
			line(png, first[0], first[1], second[0], second[1], color);
		}
		setPixel(png, Math.round(candidate.xPx), Math.round(candidate.yPx), color);
	}
	return PNG.sync.write(png);
}

export async function runDetection(args: TeeCliArgs): Promise<TeeCliResult> {
	const input = loadInput(args.inputPath);
	const cv = (await loadCv()) as unknown as TeePadCv;
	const detectionInputs = await deriveDetectionInputs(cv, input, args);
	const raster: TeePadRaster = { rgba: input.rgba, widthPx: input.widthPx, heightPx: input.heightPx, sourceScale: 1 };
	const options: CalibratedTeePadDetectionOptions = {
		uiScalePx: detectionInputs.uiScalePx,
		mapBoundsPx: detectionInputs.mapBoundsPx,
		maxCandidates: args.maxCandidates,
		ignoreCirclesPx: args.ignoreCirclesPx
	};
	let result: TeePadVariantResult | OccludedEdgeLoopResult;
	if (args.mode === 'occluded-edge-loop') result = detectCalibratedOccludedEdgeLoopCandidates(cv, raster, options);
	else result = detectCalibratedTeePadVariants(cv, raster, options, [args.mode as TeePadVariant])[0];
	if (!result) throw new Error(`Detector returned no result for mode '${args.mode}'.`);
	const candidates = result.candidates;
	const outputDir = resolve(args.outputDir);
	mkdirSync(outputDir, { recursive: true });
	const overlayPath = join(outputDir, `${args.mode}.png`);
	const jsonPath = join(outputDir, `${args.mode}.json`);
	const numberDetection = detectionInputs.numberDetection;
	const output: TeeCliResult = {
		mode: args.mode,
		input: { path: input.sourcePath, sourceEntry: input.sourceEntry, widthPx: input.widthPx, heightPx: input.heightPx, sourceScale: 1 },
		uiScalePx: detectionInputs.uiScalePx,
		mapBoundsPx: detectionInputs.mapBoundsPx,
		numberDetection: numberDetection ? {
			labeling: numberDetection.labeling,
			candidateCount: numberDetection.candidates.length,
			labeledCount: numberDetection.candidates.filter((candidate) => candidate.label !== undefined).length,
			candidates: numberDetection.candidates.map((candidate) => ({ label: candidate.label, xPx: candidate.xPx, yPx: candidate.yPx }))
		} : undefined,
		stageCounts: result.stageCounts,
		candidateCount: candidates.length,
		candidates: candidates.map(candidateOutput),
		truthEvaluation: input.truth ? evaluateTruth(input.truth, candidates, 7 * detectionInputs.uiScalePx) : undefined,
		overlayPath
	};
	writeFileSync(overlayPath, overlay(input, candidates, args.mode));
	writeFileSync(jsonPath, `${JSON.stringify(output, null, 2)}\n`);
	console.log(JSON.stringify({ ...output, jsonPath }, null, 2));
	return output;
}

async function main(): Promise<void> {
	await runDetection(parseArgs(process.argv.slice(2)));
}

if (resolve(process.argv[1] ?? '') === resolve(scriptPath)) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
