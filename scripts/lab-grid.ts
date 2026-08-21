import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { decodeImageFile } from './nuthing/decode';
import { cropRows, detectMapViewport } from '../src/lib/nuthing/viewport';
import type { RgbaImage } from '../src/lib/nuthing/raster';

const GLYPHS: Record<string, readonly string[]> = {
	'0': ['111', '101', '101', '101', '111'],
	'1': ['010', '110', '010', '010', '111'],
	'2': ['111', '001', '111', '100', '111'],
	'3': ['111', '001', '111', '001', '111'],
	'4': ['101', '101', '111', '001', '001'],
	'5': ['111', '100', '111', '001', '111'],
	'6': ['111', '100', '111', '101', '111'],
	'7': ['111', '001', '010', '010', '010'],
	'8': ['111', '101', '111', '101', '111'],
	'9': ['111', '101', '111', '001', '111'],
	X: ['101', '101', '010', '101', '101'],
	Y: ['101', '101', '010', '010', '010'],
	'+': ['000', '010', '111', '010', '000'],
	'-': ['000', '000', '111', '000', '000'],
	' ': ['000', '000', '000', '000', '000'],
};

type Color = readonly [number, number, number];

function setPixel(png: PNG, x: number, y: number, color: Color, alpha = 1): void {
	if (x < 0 || x >= png.width || y < 0 || y >= png.height) return;
	const i = (y * png.width + x) * 4;
	png.data[i] = Math.round(png.data[i] * (1 - alpha) + color[0] * alpha);
	png.data[i + 1] = Math.round(png.data[i + 1] * (1 - alpha) + color[1] * alpha);
	png.data[i + 2] = Math.round(png.data[i + 2] * (1 - alpha) + color[2] * alpha);
	png.data[i + 3] = 255;
}

function fillRect(png: PNG, x: number, y: number, w: number, h: number, color: Color, alpha: number): void {
	for (let yy = y; yy < y + h; yy++) {
		for (let xx = x; xx < x + w; xx++) setPixel(png, xx, yy, color, alpha);
	}
}

function drawText(png: PNG, text: string, x: number, y: number, color: Color, scale = 2): void {
	let cursor = x;
	for (const char of text) {
		const glyph = GLYPHS[char];
		if (!glyph) throw new Error(`Unsupported grid-label character: ${char}`);
		for (let gy = 0; gy < glyph.length; gy++) {
			for (let gx = 0; gx < glyph[gy].length; gx++) {
				if (glyph[gy][gx] !== '1') continue;
				fillRect(png, cursor + gx * scale, y + gy * scale, scale, scale, color, 1);
			}
		}
		cursor += 4 * scale;
	}
}

function textWidth(text: string, scale = 2): number {
	return Math.max(0, text.length * 4 * scale - scale);
}

function niceSpacing(width: number, height: number): number {
	const longest = Math.max(width, height);
	const target = longest / 14;
	const choices: number[] = [];
	for (let exponent = -1; exponent <= 5; exponent++) {
		for (const base of [1, 2, 5]) choices.push(base * 10 ** exponent);
	}
	return choices
		.filter((value) => longest / value >= 10 && longest / value <= 20)
		.sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0] ?? Math.max(1, Math.round(target));
}

function encodePng(image: RgbaImage): Buffer {
	const png = new PNG({ width: image.width, height: image.height });
	Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength).copy(png.data);
	return PNG.sync.write(png);
}

function renderGrid(image: RgbaImage, spacing: number): Buffer {
	const png = PNG.sync.read(encodePng(image));
	const line: Color = [70, 235, 255];
	const axis: Color = [255, 225, 70];
	const label: Color = [255, 255, 255];
	for (let x = 0; x < png.width; x += spacing) {
		for (let y = 0; y < png.height; y++) setPixel(png, x, y, x === 0 ? axis : line, x === 0 ? 0.95 : 0.58);
		const text = String(x);
		const tx = Math.min(Math.max(3, x + 3), png.width - textWidth(text) - 5);
		fillRect(png, tx - 2, 2, textWidth(text) + 4, 14, [0, 0, 0], 0.72);
		drawText(png, text, tx, 4, label);
	}
	for (let y = 0; y < png.height; y += spacing) {
		for (let x = 0; x < png.width; x++) setPixel(png, x, y, y === 0 ? axis : line, y === 0 ? 0.95 : 0.58);
		const text = String(y);
		const ty = Math.min(Math.max(20, y + 3), png.height - 13);
		fillRect(png, 2, ty - 2, textWidth(text) + 4, 14, [0, 0, 0], 0.72);
		drawText(png, text, 4, ty, label);
	}
	fillRect(png, png.width - 40, 2, 38, 14, [0, 0, 0], 0.72);
	drawText(png, '+X', png.width - 36, 4, axis);
	fillRect(png, 2, png.height - 16, 38, 14, [0, 0, 0], 0.72);
	drawText(png, '+Y', 4, png.height - 14, axis);
	return PNG.sync.write(png);
}

function findCourseRaster(corpusRoot: string, course: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(course)) throw new Error(`Invalid course name: ${course}`);
	const courseDir = join(corpusRoot, 'dev', course);
	const candidates = readdirSync(courseDir)
		.filter((name) => /-full\.(?:png|jpe?g|rgba\.bin)$/i.test(name))
		.sort((a, b) => a.localeCompare(b));
	if (candidates.length !== 1) {
		throw new Error(`Expected exactly one full raster in ${courseDir}; found ${candidates.length}`);
	}
	return join(courseDir, candidates[0]);
}

function main(): void {
	const course = process.argv[2];
	if (!course || process.argv.length !== 3) {
		console.error('Usage: ./lab grid <course>');
		process.exit(2);
	}
	const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
	const corpusRoot = process.env.CHAINSPOT_CORPUS_PATH ?? resolve(repoRoot, '..', 'chainspot-corpus');
	const sourcePath = findCourseRaster(corpusRoot, course);
	const full = decodeImageFile(sourcePath);
	const viewport = detectMapViewport(full);
	const cropped = cropRows(full, viewport);
	const spacing = niceSpacing(cropped.width, cropped.height);
	const outputDir = join(repoRoot, 'lab-artifacts', course);
	const croppedPath = join(outputDir, `${course}-cropped.png`);
	const gridPath = join(outputDir, `${course}-cropped-grid.png`);
	mkdirSync(outputDir, { recursive: true });
	writeFileSync(croppedPath, encodePng(cropped));
	writeFileSync(gridPath, renderGrid(cropped, spacing));
	console.log(`course: ${course}`);
	console.log(`source: ${sourcePath}`);
	console.log(`crop rows: [${viewport.top}, ${viewport.bottom})`);
	console.log(`crop size: ${cropped.width}x${cropped.height}`);
	console.log(`grid spacing: ${spacing}px`);
	console.log(`cropped raster: ${croppedPath}`);
	console.log(`gridded raster: ${gridPath}`);
}

main();
