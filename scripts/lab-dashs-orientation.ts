/** Course-specific orientation renderer for the blind AlexClark experiment. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { decodeImageFile } from './nuthing/decode';
import { detectMapViewport } from '../src/lib/nuthing/viewport';

type Point = { xPx: number; yPx: number };
type Hole = {
	number: number;
	tee: Point;
	basket: Point;
	corridorBends: Point[];
	corridorWidthPx: number;
};
type Color = readonly [number, number, number];

function blend(png: PNG, x: number, y: number, color: Color, alpha: number): void {
	if (x < 0 || x >= png.width || y < 0 || y >= png.height) return;
	const i = (y * png.width + x) * 4;
	png.data[i] = Math.round(png.data[i] * (1 - alpha) + color[0] * alpha);
	png.data[i + 1] = Math.round(png.data[i + 1] * (1 - alpha) + color[1] * alpha);
	png.data[i + 2] = Math.round(png.data[i + 2] * (1 - alpha) + color[2] * alpha);
	png.data[i + 3] = 255;
}

function disk(png: PNG, cx: number, cy: number, radius: number, color: Color, alpha: number): void {
	for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
		for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
			if ((x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2) blend(png, x, y, color, alpha);
		}
	}
}

function segment(png: PNG, a: Point, b: Point, width: number, color: Color, alpha: number): void {
	const dx = b.xPx - a.xPx;
	const dy = b.yPx - a.yPx;
	const length = Math.hypot(dx, dy);
	const steps = Math.max(1, Math.ceil(length / 2));
	for (let i = 0; i <= steps; i++) {
		const t = i / steps;
		disk(png, a.xPx + dx * t, a.yPx + dy * t, width / 2, color, alpha);
	}
}

function ring(png: PNG, point: Point, radius: number, width: number, color: Color): void {
	for (let y = Math.floor(point.yPx - radius - width); y <= Math.ceil(point.yPx + radius + width); y++) {
		for (let x = Math.floor(point.xPx - radius - width); x <= Math.ceil(point.xPx + radius + width); x++) {
			const d = Math.hypot(x - point.xPx, y - point.yPx);
			if (Math.abs(d - radius) <= width / 2) blend(png, x, y, color, 0.98);
		}
	}
}

function render(basePath: string, outputPath: string, holes: Hole[], cropTop: number): void {
	const png = PNG.sync.read(readFileSync(basePath));
	for (const hole of holes) {
		const local = (point: Point): Point => ({ xPx: point.xPx, yPx: point.yPx - cropTop });
		const tee = local(hole.tee);
		const basket = local(hole.basket);
		const bends = hole.corridorBends.map(local);
		const path = [tee, ...bends, basket];
		for (let i = 1; i < path.length; i++) segment(png, path[i - 1], path[i], hole.corridorWidthPx, [30, 210, 255], 0.16);
		for (let i = 1; i < path.length; i++) segment(png, path[i - 1], path[i], 3, [30, 210, 255], 0.92);
		ring(png, tee, 12, 4, [60, 255, 90]);
		ring(png, basket, 12, 4, [255, 60, 210]);
		for (const bend of bends) {
			disk(png, bend.xPx, bend.yPx, 9, [255, 190, 30], 0.9);
			disk(png, bend.xPx, bend.yPx, 3, [20, 20, 20], 1);
		}
	}
	writeFileSync(outputPath, PNG.sync.write(png));
}

const repoRoot = resolve(import.meta.dirname, '..');
const corpusRoot = process.env.CHAINSPOT_CORPUS_PATH ?? resolve(repoRoot, '..', 'chainspot-corpus');
const courseDir = join(corpusRoot, 'dev', 'DashsTrack');
const sourcePath = join(courseDir, 'DashsTrack-full.jpg');
const truthPath = join(courseDir, 'DashsTrack-full.annotation.json');
const outputDir = join(repoRoot, 'lab-artifacts', 'DashsTrack');
const truth = JSON.parse(readFileSync(truthPath, 'utf8')) as { holes: Hole[] };
const cropTop = detectMapViewport(decodeImageFile(sourcePath)).top;
render(
	join(outputDir, 'DashsTrack-cropped.png'),
	join(outputDir, 'DashsTrack-cropped-annotation.png'),
	truth.holes,
	cropTop,
);
render(
	join(outputDir, 'DashsTrack-cropped-grid.png'),
	join(outputDir, 'DashsTrack-cropped-annotation-grid.png'),
	truth.holes,
	cropTop,
);
console.log(`DashsTrack truth transformed to crop-local coordinates with y' = y - ${cropTop}`);
