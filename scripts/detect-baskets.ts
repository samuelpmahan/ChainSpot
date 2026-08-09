import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { strFromU8, unzipSync } from 'fflate';
import { PNG } from 'pngjs';
import { loadCv } from '../src/lib/stitch/cvMatch';
import {
	detectBasketCandidatesAtTemplateScale,
	findCalibratedBasketAnchorScale
} from '../src/lib/autoAnnotation/cvCalibratedDetectors';
import { asTemplateScale } from '../src/lib/autoAnnotation/cvCalibration';
import type {
	BasketCandidate,
	BasketCv,
	BasketRaster,
	BasketTemplateRaster
} from '../src/lib/autoAnnotation/basketTemplateDetection';
import type { TemplateScale } from '../src/lib/autoAnnotation/cvCalibration';
import { detectHoleNumberBadges } from '../src/lib/autoAnnotation/holeNumberDetection';
import type { HoleNumberCvModule, HoleNumberTemplate } from '../src/lib/autoAnnotation/holeNumberDetection';

export interface BasketCliArgs {
	readonly inputPath: string;
	readonly outputDir: string;
	readonly templateDir: string;
	/** Basket-template scale in source pixels; omitted means CLI-only discovery. */
	readonly basketScale?: number;
	readonly mapTopPx?: number;
	readonly mapBottomPx?: number;
	readonly maxCandidates: number;
	readonly minScore?: number;
}

interface DecodedRaster {
	readonly rgba: Uint8Array;
	readonly widthPx: number;
	readonly heightPx: number;
}

export interface BasketTruth {
	readonly number: number;
	readonly xPx: number;
	readonly yPx: number;
}

interface LoadedInput extends DecodedRaster {
	readonly sourcePath: string;
	readonly sourceEntry?: string;
	readonly truth?: readonly BasketTruth[];
}

interface BasketProjectDocument {
	readonly images?: readonly Readonly<{
		role?: unknown;
		mimeType?: unknown;
		fileName?: unknown;
		bundlePath?: unknown;
	}>[];
	readonly holes?: readonly Readonly<{
		number?: unknown;
		basket?: Readonly<{ xPx?: unknown; yPx?: unknown }>;
	}>[];
}

export interface BasketCliResult {
	readonly input: {
		readonly path: string;
		readonly sourceEntry?: string;
		readonly widthPx: number;
		readonly heightPx: number;
	};
	readonly basketScale: number;
	readonly mapBoundsPx?: Readonly<{ topPx: number; bottomPx: number }>;
	readonly candidateCount: number;
	readonly candidates: readonly Readonly<{
		index: number;
		center: { xPx: number; yPx: number };
		widthPx: number;
		heightPx: number;
		score: number;
	}>[];
	readonly truthEvaluation?: BasketTruthEvaluation;
	readonly overlayPath: string;
}

export interface BasketTruthEvaluation {
	readonly tolerancePx: number;
	readonly truthCount: number;
	readonly matchedNumbers: readonly number[];
	readonly missedNumbers: readonly number[];
	readonly falsePositiveCount: number;
	readonly falsePositives: readonly Readonly<{ xPx: number; yPx: number; score: number }>[];
}

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), '..');
const defaultTemplateDir = join(projectRoot, 'static', 'resources', 'chainspot_cv_templates');

function usage(): string {
	return [
		'Usage: npm run detect:baskets -- <image-or-chainspot-zip> --out <directory>',
		'',
		'Options:',
		'  --templates <directory>       Canonical templates directory (default: static/resources/chainspot_cv_templates)',
		'  --basket-scale <multiple>     Override scale; default is a CLI-only 0.4..4.0 blind sweep',
		'  --map-top <source-pixels>    Restrict detection to this source row',
		'  --map-bottom <source-pixels> Restrict detection to this source row',
		'  --max-candidates <count>     Candidate limit (default: 18)',
		'  --min-score <0..1>           Normalized cross-correlation floor (default: 0.50)',
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

export function parseArgs(argv: readonly string[]): BasketCliArgs {
	if (argv.includes('--help')) throw new Error(usage());

	let positional: string | undefined;
	let outputDir: string | undefined;
	let templateDir = defaultTemplateDir;
	let basketScale: number | undefined;
	let mapTopPx: number | undefined;
	let mapBottomPx: number | undefined;
	let maxCandidates = 18;
	let minScore: number | undefined;

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (!argument.startsWith('--')) {
			if (positional) throw new Error(`Only one input path is supported; received '${argument}'.`);
			positional = argument;
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
			case '--basket-scale':
				basketScale = finiteNumber(requireValue(argv, index, argument), argument);
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
				if (!Number.isInteger(maxCandidates) || maxCandidates < 1) {
					throw new Error('--max-candidates must be a positive integer.');
				}
				break;
			case '--min-score':
				minScore = finiteNumber(requireValue(argv, index, argument), argument);
				index += 1;
				break;
			default:
				throw new Error(`Unknown option '${argument}'.\n\n${usage()}`);
		}
	}

	if (!positional) throw new Error(`An image or .chainspot.zip input is required.\n\n${usage()}`);
	if (!outputDir) throw new Error(`--out is required.\n\n${usage()}`);
	if (basketScale !== undefined && basketScale <= 0) throw new Error('--basket-scale must be positive.');
	if (minScore !== undefined && (minScore < -1 || minScore > 1)) throw new Error('--min-score must be between -1 and 1.');
	if (mapTopPx !== undefined && mapBottomPx !== undefined && mapTopPx > mapBottomPx) {
		throw new Error('--map-top cannot be greater than --map-bottom.');
	}
	if ((mapTopPx === undefined) !== (mapBottomPx === undefined)) {
		throw new Error('--map-top and --map-bottom must be provided together.');
	}
	return { inputPath: positional, outputDir, templateDir, basketScale, mapTopPx, mapBottomPx, maxCandidates, minScore };
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

function truthFromDocument(document: BasketProjectDocument): readonly BasketTruth[] {
	return (document.holes ?? [])
		.map((hole) => ({
			number: typeof hole.number === 'number' ? hole.number : NaN,
			xPx: typeof hole.basket?.xPx === 'number' ? hole.basket.xPx : NaN,
			yPx: typeof hole.basket?.yPx === 'number' ? hole.basket.yPx : NaN
		}))
		.filter((hole) => Number.isInteger(hole.number) && Number.isFinite(hole.xPx) && Number.isFinite(hole.yPx))
		.sort((a, b) => a.number - b.number);
}

function loadInput(inputPath: string): LoadedInput {
	const resolvedInput = resolve(inputPath);
	const bytes = new Uint8Array(readFileSync(resolvedInput));
	if (!resolvedInput.toLowerCase().endsWith('.chainspot.zip')) {
		return { ...decodeRaster(bytes, resolvedInput), sourcePath: resolvedInput };
	}

	const entries = unzipSync(bytes);
	const jsonBytes = entries['project.json'];
	if (!jsonBytes) throw new Error(`Bundle '${resolvedInput}' does not contain project.json.`);
	const document = JSON.parse(strFromU8(jsonBytes)) as BasketProjectDocument;
	const sourceManifest = (document.images ?? []).find((image) => image.role === 'source-overview');
	const sourceEntry = sourceManifest?.bundlePath;
	if (typeof sourceEntry !== 'string' || !sourceEntry.startsWith('images/')) {
		throw new Error(`Bundle '${resolvedInput}' does not contain a safe source-overview image path.`);
	}
	const sourceBytes = entries[sourceEntry];
	if (!sourceBytes) throw new Error(`Bundle '${resolvedInput}' is missing ${sourceEntry}.`);
	return {
		...decodeRaster(sourceBytes, typeof sourceManifest?.fileName === 'string' ? sourceManifest.fileName : sourceEntry),
		sourcePath: resolvedInput,
		sourceEntry,
		truth: truthFromDocument(document)
	};
}

function toGray(raster: DecodedRaster): Uint8Array {
	const gray = new Uint8Array(raster.widthPx * raster.heightPx);
	for (let pixel = 0, offset = 0; pixel < gray.length; pixel += 1, offset += 4) {
		gray[pixel] = (raster.rgba[offset] * 0.299 + raster.rgba[offset + 1] * 0.587 + raster.rgba[offset + 2] * 0.114 + 0.5) | 0;
	}
	return gray;
}

function loadTemplateRaster(templateDir: string, fileName: string): DecodedRaster {
	const path = join(resolve(templateDir), fileName);
	return decodeRaster(new Uint8Array(readFileSync(path)), path);
}

function loadBasketTemplate(templateDir: string): BasketTemplateRaster {
	const decoded = loadTemplateRaster(templateDir, 'basket.png');
	return { gray: toGray(decoded), widthPx: decoded.widthPx, heightPx: decoded.heightPx };
}

function loadNumberTemplates(templateDir: string): readonly HoleNumberTemplate[] {
	return Array.from({ length: 18 }, (_, index) => {
		const label = index + 1;
		const fileName = `hole-${String(label).padStart(2, '0')}.png`;
		const decoded = loadTemplateRaster(templateDir, fileName);
		return {
			label,
			raster: { format: 'rgba' as const, widthPx: decoded.widthPx, heightPx: decoded.heightPx, data: decoded.rgba }
		};
	});
}

function deriveMapBounds(
	truthCandidates: readonly { readonly yPx: number }[],
	heightPx: number
): Readonly<{ topPx: number; bottomPx: number }> | undefined {
	if (truthCandidates.length < 3) return undefined;
	const ys = truthCandidates.map((candidate) => candidate.yPx);
	const minY = Math.min(...ys);
	const maxY = Math.max(...ys);
	const margin = Math.max(80, Math.min(300, (maxY - minY) * 0.3));
	return { topPx: Math.max(0, minY - margin), bottomPx: Math.min(heightPx, maxY + margin) };
}

function deriveMapBoundsPx(
	cv: HoleNumberCvModule,
	input: LoadedInput,
	args: BasketCliArgs
): Readonly<{ topPx: number; bottomPx: number }> | undefined {
	if (args.mapTopPx !== undefined && args.mapBottomPx !== undefined) {
		return { topPx: args.mapTopPx, bottomPx: args.mapBottomPx };
	}
	try {
		const detection = detectHoleNumberBadges(
			cv,
			{ format: 'rgba', widthPx: input.widthPx, heightPx: input.heightPx, data: input.rgba },
			loadNumberTemplates(args.templateDir)
		);
		return deriveMapBounds(detection.candidates, input.heightPx);
	} catch {
		return undefined;
	}
}

export function evaluateTruth(
	truth: readonly BasketTruth[],
	candidates: readonly BasketCandidate[],
	tolerancePx: number
): BasketTruthEvaluation {
	const used = new Set<number>();
	const matchedNumbers: number[] = [];
	for (const expected of truth) {
		let bestIndex = -1;
		let bestDistance = Number.POSITIVE_INFINITY;
		for (let index = 0; index < candidates.length; index += 1) {
			if (used.has(index)) continue;
			const candidate = candidates[index];
			const distance = Math.hypot(candidate.xPx - expected.xPx, candidate.yPx - expected.yPx);
			if (distance < bestDistance) {
				bestDistance = distance;
				bestIndex = index;
			}
		}
		if (bestIndex >= 0 && bestDistance <= tolerancePx) {
			used.add(bestIndex);
			matchedNumbers.push(expected.number);
		}
	}
	const missedNumbers = truth.map((expected) => expected.number).filter((number) => !matchedNumbers.includes(number));
	const falsePositives = candidates
		.map((candidate, index) => ({ candidate, index }))
		.filter(({ index }) => !used.has(index))
		.map(({ candidate }) => ({ xPx: candidate.xPx, yPx: candidate.yPx, score: candidate.score }));
	return {
		tolerancePx,
		truthCount: truth.length,
		matchedNumbers,
		missedNumbers,
		falsePositiveCount: falsePositives.length,
		falsePositives
	};
}

function setPixel(png: PNG, x: number, y: number, color: readonly [number, number, number, number]): void {
	if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
	const offset = (y * png.width + x) * 4;
	png.data[offset] = color[0];
	png.data[offset + 1] = color[1];
	png.data[offset + 2] = color[2];
	png.data[offset + 3] = color[3];
}

function line(png: PNG, x0: number, y0: number, x1: number, y1: number, color: readonly [number, number, number, number]): void {
	let x = Math.round(x0);
	let y = Math.round(y0);
	const targetX = Math.round(x1);
	const targetY = Math.round(y1);
	const dx = Math.abs(targetX - x);
	const dy = Math.abs(targetY - y);
	const stepX = x < targetX ? 1 : -1;
	const stepY = y < targetY ? 1 : -1;
	let error = dx - dy;
	while (true) {
		setPixel(png, x, y, color);
		if (x === targetX && y === targetY) break;
		const doubled = 2 * error;
		if (doubled > -dy) {
			error -= dy;
			x += stepX;
		}
		if (doubled < dx) {
			error += dx;
			y += stepY;
		}
	}
}

const OVERLAY_COLOR: readonly [number, number, number, number] = [64, 220, 128, 255];

function overlay(raster: DecodedRaster, candidates: readonly BasketCandidate[]): Buffer {
	const png = new PNG({ width: raster.widthPx, height: raster.heightPx });
	png.data.set(raster.rgba);
	for (const candidate of candidates) {
		const halfWidth = candidate.widthPx * 0.5;
		const halfHeight = candidate.heightPx * 0.5;
		const left = candidate.xPx - halfWidth;
		const right = candidate.xPx + halfWidth;
		const top = candidate.yPx - halfHeight;
		const bottom = candidate.yPx + halfHeight;
		line(png, left, top, right, top, OVERLAY_COLOR);
		line(png, right, top, right, bottom, OVERLAY_COLOR);
		line(png, right, bottom, left, bottom, OVERLAY_COLOR);
		line(png, left, bottom, left, top, OVERLAY_COLOR);
		for (let dy = -3; dy <= 3; dy += 1) setPixel(png, Math.round(candidate.xPx), Math.round(candidate.yPx) + dy, OVERLAY_COLOR);
		for (let dx = -3; dx <= 3; dx += 1) setPixel(png, Math.round(candidate.xPx) + dx, Math.round(candidate.yPx), OVERLAY_COLOR);
	}
	return PNG.sync.write(png);
}

function candidateOutput(candidate: BasketCandidate, index: number): BasketCliResult['candidates'][number] {
	return {
		index,
		center: { xPx: candidate.xPx, yPx: candidate.yPx },
		widthPx: candidate.widthPx,
		heightPx: candidate.heightPx,
		score: candidate.score
	};
}

export async function runDetection(args: BasketCliArgs): Promise<BasketCliResult> {
	const input = loadInput(args.inputPath);
	const cv = (await loadCv()) as unknown as HoleNumberCvModule & BasketCv;
	const basketTemplate = loadBasketTemplate(args.templateDir);
	const raster: BasketRaster = {
		gray: toGray(input),
		widthPx: input.widthPx,
		heightPx: input.heightPx,
		sourceScale: 1
	};
	const mapBoundsPx = deriveMapBoundsPx(cv, input, args);
	const basketScale: TemplateScale | undefined = args.basketScale !== undefined
		? asTemplateScale(args.basketScale, 'CLI basket template scale')
		: findCalibratedBasketAnchorScale(cv, raster, basketTemplate, {
			onProgress: ({ scale, score }) => {
				process.stderr.write(`basket scale ${scale.toFixed(2)} · max score ${score.toFixed(3)}\n`);
			}
		})?.scale;
	if (!basketScale) throw new Error('Could not find a basket template scale via blind sweep; pass --basket-scale.');

	const candidates = detectBasketCandidatesAtTemplateScale(cv, raster, basketTemplate, {
		templateScale: basketScale,
		mapBoundsPx,
		maxCandidates: args.maxCandidates,
		minScore: args.minScore
	});
	const outputDir = resolve(args.outputDir);
	mkdirSync(outputDir, { recursive: true });
	const overlayPath = join(outputDir, 'baskets.png');
	const jsonPath = join(outputDir, 'baskets.json');
	const output: BasketCliResult = {
		input: {
			path: input.sourcePath,
			sourceEntry: input.sourceEntry,
			widthPx: input.widthPx,
			heightPx: input.heightPx
		},
		basketScale,
		mapBoundsPx,
		candidateCount: candidates.length,
		candidates: candidates.map(candidateOutput),
		truthEvaluation: input.truth ? evaluateTruth(input.truth, candidates, 7 * basketScale) : undefined,
		overlayPath
	};
	writeFileSync(overlayPath, overlay(input, candidates));
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
