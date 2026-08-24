import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';

interface CacheLeg {
	endpointId: string;
	path: number[];
	reachable: boolean;
}
interface CacheBadge {
	id: string;
	label: string;
	cx: number;
	cy: number;
	legs: CacheLeg[];
}
interface CacheCourse {
	course: string;
	viewport: { topPx: number; bottomPx: number };
	field: { width: number; height: number; scale: number };
	badges: CacheBadge[];
	endpoints: {
		tees: { id: string; x: number; y: number }[];
		baskets: { id: string; x: number; y: number }[];
	};
}
interface PredictionRow {
	badgeId: string;
	label: string;
	teeId: string | null;
	basketId: string | null;
}
interface Predictions {
	predictions: Record<string, { rows: PredictionRow[] }>;
}

function decode(path: string): PNG {
	const bytes = readFileSync(path);
	const ext = extname(path).toLowerCase();
	if (ext === '.png') return PNG.sync.read(bytes);
	if (ext === '.jpg' || ext === '.jpeg') {
		const image = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
		const png = new PNG({ width: image.width, height: image.height });
		png.data.set(image.data);
		return png;
	}
	throw new Error(`Unsupported image extension: ${ext}`);
}
function color(index: number): [number, number, number] {
	const hue = ((index * 137.508) % 360) / 60;
	const chroma = 220;
	const x = chroma * (1 - Math.abs((hue % 2) - 1));
	let rgb: [number, number, number];
	if (hue < 1) rgb = [chroma, x, 0];
	else if (hue < 2) rgb = [x, chroma, 0];
	else if (hue < 3) rgb = [0, chroma, x];
	else if (hue < 4) rgb = [0, x, chroma];
	else if (hue < 5) rgb = [x, 0, chroma];
	else rgb = [chroma, 0, x];
	return rgb.map((value) => Math.round(value + 25)) as [number, number, number];
}
function mark(png: PNG, x: number, y: number, rgb: [number, number, number], radius = 1): void {
	for (let dy = -radius; dy <= radius; dy++) {
		for (let dx = -radius; dx <= radius; dx++) {
			const xx = Math.round(x + dx);
			const yy = Math.round(y + dy);
			if (xx < 0 || yy < 0 || xx >= png.width || yy >= png.height) continue;
			const p = (yy * png.width + xx) * 4;
			png.data[p] = rgb[0];
			png.data[p + 1] = rgb[1];
			png.data[p + 2] = rgb[2];
			png.data[p + 3] = 255;
		}
	}
}
const DIGITS: Record<string, string[]> = {
	'0': ['111', '101', '101', '101', '111'],
	'1': ['010', '110', '010', '010', '111'],
	'2': ['111', '001', '111', '100', '111'],
	'3': ['111', '001', '111', '001', '111'],
	'4': ['101', '101', '111', '001', '001'],
	'5': ['111', '100', '111', '001', '111'],
	'6': ['111', '100', '111', '101', '111'],
	'7': ['111', '001', '001', '001', '001'],
	'8': ['111', '101', '111', '101', '111'],
	'9': ['111', '101', '111', '001', '111']
};
function drawLabel(png: PNG, label: string, x: number, y: number): void {
	const scale = 3;
	const width = label.length * 4 * scale - scale;
	const x0 = Math.round(x - width / 2);
	const y0 = Math.round(y - 23);
	for (let i = 0; i < label.length; i++) {
		const glyph = DIGITS[label[i]];
		if (!glyph) continue;
		for (let gy = 0; gy < glyph.length; gy++) {
			for (let gx = 0; gx < glyph[gy].length; gx++) {
				if (glyph[gy][gx] !== '1') continue;
				for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
					mark(png, x0 + (i * 4 + gx) * scale + sx, y0 + gy * scale + sy, [255, 255, 255], 0);
				}
			}
		}
	}
}

function main(): void {
	const args = process.argv.slice(2);
	const take = (flag: string): string | null => {
		const index = args.indexOf(flag);
		if (index < 0) return null;
		const value = args[index + 1] ?? null;
		args.splice(index, 2);
		return value;
	};
	const imagePath = take('--image');
	const cachePath = take('--cache');
	const predictionsPath = take('--predictions');
	const course = take('--course');
	const outPath = take('--out');
	if (!imagePath || !cachePath || !predictionsPath || !course || !outPath) {
		throw new Error('Usage: apgd-threefactor-render.ts --image I --cache C.json --predictions P.json --course NAME --out O.png');
	}
	const png = decode(resolve(imagePath));
	const cache = JSON.parse(readFileSync(resolve(cachePath), 'utf8')) as CacheCourse;
	const predictions = JSON.parse(readFileSync(resolve(predictionsPath), 'utf8')) as Predictions;
	const rows = predictions.predictions[course]?.rows;
	if (!rows) throw new Error(`No predictions for ${course}`);
	const top = cache.viewport.topPx;
	const scale = cache.field.scale;
	for (let i = 0; i < rows.length; i++) {
		const prediction = rows[i];
		const badge = cache.badges.find((candidate) => candidate.id === prediction.badgeId);
		if (!badge) continue;
		const rgb = color(Number(prediction.label) || i + 1);
		for (const endpointId of [prediction.teeId, prediction.basketId]) {
			if (!endpointId) continue;
			const leg = badge.legs.find((candidate) => candidate.endpointId === endpointId);
			if (!leg) continue;
			for (let p = 0; p < leg.path.length; p += 2) {
				mark(png, (leg.path[p] + 0.5) * scale, (leg.path[p + 1] + 0.5) * scale + top, rgb, 1);
			}
		}
		mark(png, badge.cx, badge.cy + top, [255, 30, 30], 4);
		const tee = cache.endpoints.tees.find((endpoint) => endpoint.id === prediction.teeId);
		const basket = cache.endpoints.baskets.find((endpoint) => endpoint.id === prediction.basketId);
		if (tee) mark(png, tee.x, tee.y + top, [20, 255, 20], 5);
		if (basket) mark(png, basket.x, basket.y + top, [40, 120, 255], 5);
		drawLabel(png, prediction.label, badge.cx, badge.cy + top);
	}
	const output = resolve(outPath);
	mkdirSync(dirname(output), { recursive: true });
	writeFileSync(output, PNG.sync.write(png));
	console.log(`${course}: rendered ${rows.length} predicted holes -> ${output}`);
}

main();
