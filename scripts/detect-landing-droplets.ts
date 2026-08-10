import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { loadCv } from '../src/lib/stitch/cvMatch';
import {
	classifyLandingDropletGlyphs,
	findLandingDroplets,
	landingDropletGlyphTemplateFromMask
} from '../src/lib/autoAnnotation/landingDropletDetection';
import type {
	DeferredOverlapRegion,
	LandingDropletCv,
	LandingDropletGlyphTemplate,
	LandingDropletRaster,
	LandingMarkerCandidate,
	LandingMarkerKind
} from '../src/lib/autoAnnotation/landingDropletDetection';

export interface LandingDropletCliArgs {
	readonly inputPath: string;
	readonly outputDir: string;
	readonly templateDir: string;
}

interface DecodedRaster {
	readonly rgba: Uint8Array;
	readonly widthPx: number;
	readonly heightPx: number;
}

export interface LandingDropletCliResult {
	readonly input: {
		readonly path: string;
		readonly widthPx: number;
		readonly heightPx: number;
	};
	readonly candidateCount: number;
	readonly candidates: readonly Readonly<{
		index: number;
		tip: { xPx: number; yPx: number };
		boundsPx: { xPx: number; yPx: number; widthPx: number; heightPx: number };
		kind: LandingMarkerKind;
		glyphConfidence: number;
	}>[];
	readonly deferredOverlapCount: number;
	readonly deferredOverlaps: readonly DeferredOverlapRegion[];
	readonly overlayPath: string;
}

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), '..');
const defaultTemplateDir = join(projectRoot, 'static', 'resources', 'chainspot_cv_templates');
const GLYPH_KINDS: readonly LandingMarkerKind[] = ['c1', 'c2', 'off-fairway'];

function usage(): string {
	return [
		'Usage: npm run detect:landing-droplets -- <image> --out <directory>',
		'',
		'Options:',
		'  --templates <directory>   Canonical templates directory (default: static/resources/chainspot_cv_templates)',
		'  --help'
	].join('\n');
}

function requireValue(argv: readonly string[], index: number, option: string): string {
	const value = argv[index + 1];
	if (!value || value.startsWith('--')) throw new Error(`${option} requires a value.\n\n${usage()}`);
	return value;
}

export function parseArgs(argv: readonly string[]): LandingDropletCliArgs {
	if (argv.includes('--help')) throw new Error(usage());

	let positional: string | undefined;
	let outputDir: string | undefined;
	let templateDir = defaultTemplateDir;

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
			default:
				throw new Error(`Unknown option '${argument}'.\n\n${usage()}`);
		}
	}

	if (!positional) throw new Error(`An image input is required.\n\n${usage()}`);
	if (!outputDir) throw new Error(`--out is required.\n\n${usage()}`);
	return { inputPath: positional, outputDir, templateDir };
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
	throw new Error(`Unsupported image format '${extension}'. Use PNG or JPEG.`);
}

function loadGlyphTemplates(templateDir: string): readonly LandingDropletGlyphTemplate[] {
	return GLYPH_KINDS.map((kind) => {
		const fileName = `round-landing-glyph-${kind}.png`;
		const path = join(resolve(templateDir), fileName);
		const decoded = decodeRaster(new Uint8Array(readFileSync(path)), fileName);
		const gray = new Uint8Array(decoded.widthPx * decoded.heightPx);
		for (let pixel = 0, offset = 0; pixel < gray.length; pixel += 1, offset += 4) gray[pixel] = decoded.rgba[offset];
		return landingDropletGlyphTemplateFromMask(kind, gray, decoded.widthPx, decoded.heightPx);
	});
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

function rectangle(png: PNG, bounds: { xPx: number; yPx: number; widthPx: number; heightPx: number }, color: readonly [number, number, number, number]): void {
	const left = bounds.xPx;
	const top = bounds.yPx;
	const right = bounds.xPx + bounds.widthPx;
	const bottom = bounds.yPx + bounds.heightPx;
	line(png, left, top, right, top, color);
	line(png, right, top, right, bottom, color);
	line(png, right, bottom, left, bottom, color);
	line(png, left, bottom, left, top, color);
}

function crosshair(png: PNG, xPx: number, yPx: number, color: readonly [number, number, number, number]): void {
	for (let dy = -5; dy <= 5; dy += 1) setPixel(png, Math.round(xPx), Math.round(yPx) + dy, color);
	for (let dx = -5; dx <= 5; dx += 1) setPixel(png, Math.round(xPx) + dx, Math.round(yPx), color);
}

/** Class-specific colors so an overlay is legible without reading labels. */
const KIND_COLOR: Record<LandingMarkerKind, readonly [number, number, number, number]> = {
	c1: [64, 220, 128, 255],
	c2: [255, 196, 32, 255],
	'off-fairway': [255, 64, 96, 255]
};
const DEFERRED_COLOR: readonly [number, number, number, number] = [255, 140, 0, 255];
const TIP_COLOR: readonly [number, number, number, number] = [255, 255, 255, 255];

function overlay(
	raster: DecodedRaster,
	candidates: readonly LandingMarkerCandidate[],
	deferredOverlaps: readonly DeferredOverlapRegion[]
): Buffer {
	const png = new PNG({ width: raster.widthPx, height: raster.heightPx });
	png.data.set(raster.rgba);
	for (const candidate of candidates) {
		const color = KIND_COLOR[candidate.kind];
		rectangle(png, candidate.boundsPx, color);
		crosshair(png, candidate.tip.xPx, candidate.tip.yPx, TIP_COLOR);
	}
	for (const region of deferredOverlaps) {
		rectangle(png, region.boundsPx, DEFERRED_COLOR);
	}
	return PNG.sync.write(png);
}

export async function runDetection(args: LandingDropletCliArgs): Promise<LandingDropletCliResult> {
	const resolvedInput = resolve(args.inputPath);
	const raster = decodeRaster(new Uint8Array(readFileSync(resolvedInput)), resolvedInput);
	const cv = (await loadCv()) as unknown as LandingDropletCv;
	const templates = loadGlyphTemplates(args.templateDir);

	const detectionRaster: LandingDropletRaster = { rgba: raster.rgba, widthPx: raster.widthPx, heightPx: raster.heightPx, sourceScale: 1 };
	const { droplets, deferredOverlaps } = findLandingDroplets(cv, detectionRaster);
	const candidates = classifyLandingDropletGlyphs(detectionRaster, droplets, templates);

	const outputDir = resolve(args.outputDir);
	mkdirSync(outputDir, { recursive: true });
	const overlayPath = join(outputDir, 'landing-droplets.png');
	const jsonPath = join(outputDir, 'landing-droplets.json');

	const output: LandingDropletCliResult = {
		input: { path: resolvedInput, widthPx: raster.widthPx, heightPx: raster.heightPx },
		candidateCount: candidates.length,
		candidates: candidates.map((candidate, index) => ({
			index,
			tip: candidate.tip,
			boundsPx: candidate.boundsPx,
			kind: candidate.kind,
			glyphConfidence: candidate.glyphConfidence
		})),
		deferredOverlapCount: deferredOverlaps.length,
		deferredOverlaps,
		overlayPath
	};

	writeFileSync(overlayPath, overlay(raster, candidates, deferredOverlaps));
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
