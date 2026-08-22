import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';

const OFFSETS = [-1.25, -1, -0.8, -0.65, -0.5, -0.35, -0.2, 0, 0.2, 0.35, 0.5, 0.65, 0.8, 1, 1.25] as const;
const PROFILE_WIDTHS = [30, 37, 40] as const;
const OVERLAY = [179, 179, 179] as const;
const SUPPORT_TAU = 0.5;
const WORST_WINDOW_SRC_PX = 45;

interface ImageRgb {
	width: number;
	height: number;
	data: Uint8Array;
}
interface CacheLeg {
	endpointId: string;
	path: number[];
	reachable: boolean;
	geodesic?: number | null;
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
	endpoints: {
		tees: { id: string; x: number; y: number; angle?: number | null; tier?: string }[];
		baskets: { id: string; x: number; y: number; score?: number }[];
	};
	badges: CacheBadge[];
}

function decodeRgb(path: string, topPx: number, bottomPx: number): ImageRgb {
	const bytes = readFileSync(path);
	const ext = extname(path).toLowerCase();
	let width: number;
	let height: number;
	let rgba: Uint8Array;
	if (ext === '.png') {
		const png = PNG.sync.read(bytes);
		width = png.width;
		height = png.height;
		rgba = new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength);
	} else if (ext === '.jpg' || ext === '.jpeg') {
		const image = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
		width = image.width;
		height = image.height;
		rgba = new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength);
	} else throw new Error(`Unsupported image extension: ${ext}`);
	const top = Math.max(0, Math.min(height - 1, topPx));
	const bottom = Math.max(top + 1, Math.min(height, bottomPx));
	const out = new Uint8Array(width * (bottom - top) * 3);
	let q = 0;
	for (let y = top; y < bottom; y++) {
		for (let x = 0; x < width; x++) {
			const p = (y * width + x) * 4;
			out[q++] = rgba[p];
			out[q++] = rgba[p + 1];
			out[q++] = rgba[p + 2];
		}
	}
	return { width, height: bottom - top, data: out };
}
function mean(values: readonly number[]): number {
	return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}
function quantile(values: readonly number[], p: number): number {
	if (!values.length) return 0;
	const xs = [...values].sort((a, b) => a - b);
	const x = (xs.length - 1) * p;
	const lo = Math.floor(x);
	const hi = Math.ceil(x);
	if (lo === hi) return xs[lo];
	return xs[lo] * (hi - x) + xs[hi] * (x - lo);
}
function clamp(value: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, value));
}
function bilinear(image: ImageRgb, x: number, y: number): [number, number, number] {
	x = clamp(x, 0, image.width - 1.001);
	y = clamp(y, 0, image.height - 1.001);
	const x0 = Math.floor(x);
	const y0 = Math.floor(y);
	const x1 = Math.min(image.width - 1, x0 + 1);
	const y1 = Math.min(image.height - 1, y0 + 1);
	const dx = x - x0;
	const dy = y - y0;
	const read = (xx: number, yy: number, channel: number): number => image.data[(yy * image.width + xx) * 3 + channel];
	const out: number[] = [];
	for (let c = 0; c < 3; c++) {
		out[c] =
			read(x0, y0, c) * (1 - dx) * (1 - dy) +
			read(x1, y0, c) * dx * (1 - dy) +
			read(x0, y1, c) * (1 - dx) * dy +
			read(x1, y1, c) * dx * dy;
	}
	return out as [number, number, number];
}
function knownPoint(cache: CacheCourse, x: number, y: number): boolean {
	for (const badge of cache.badges) if (Math.abs(x - badge.cx) <= 30 && Math.abs(y - badge.cy) <= 26) return false;
	for (const tee of cache.endpoints.tees) if (Math.hypot(x - tee.x, y - tee.y) <= 24) return false;
	for (const basket of cache.endpoints.baskets) if (Math.hypot(x - basket.x, y - basket.y) <= 40) return false;
	return true;
}
function supportStats(cache: CacheCourse, support: Float32Array, leg: CacheLeg): Record<string, number> {
	const samples: number[] = [];
	for (let i = 0; i < leg.path.length; i += 2) {
		const x = leg.path[i];
		const y = leg.path[i + 1];
		if (x < 0 || x >= cache.field.width || y < 0 || y >= cache.field.height) continue;
		samples.push(support[y * cache.field.width + x] ?? 0);
	}
	const windowCells = Math.max(3, Math.round(WORST_WINDOW_SRC_PX / cache.field.scale));
	let worst = mean(samples);
	if (samples.length > windowCells) {
		let sum = samples.slice(0, windowCells).reduce((a, b) => a + b, 0);
		worst = sum / windowCells;
		for (let i = windowCells; i < samples.length; i++) {
			sum += samples[i] - samples[i - windowCells];
			worst = Math.min(worst, sum / windowCells);
		}
	}
	return {
		supportMean: mean(samples),
		supportQ25: quantile(samples, 0.25),
		supportWorst: worst,
		supportFracLow: samples.length ? samples.filter((x) => x < SUPPORT_TAU).length / samples.length : 1
	};
}
function profileAtWidth(image: ImageRgb, cache: CacheCourse, leg: CacheLeg, widthPx: number): { contrastFracLow: number | null; pairedEdgeQ25: number | null; points: number } {
	const cells: [number, number][] = [];
	for (let i = 0; i < leg.path.length; i += 2) cells.push([leg.path[i], leg.path[i + 1]]);
	const far = OFFSETS.map((u, i) => ({ u, i })).filter(({ u }) => Math.abs(u) >= 1).map(({ i }) => i);
	const inner = OFFSETS.map((u, i) => ({ u, i })).filter(({ u }) => Math.abs(u) <= 0.35).map(({ i }) => i);
	const outer = OFFSETS.map((u, i) => ({ u, i })).filter(({ u }) => Math.abs(u) >= 0.8).map(({ i }) => i);
	const nearestOffset = (u: number): number => OFFSETS.reduce((best, value, i) => Math.abs(value - u) < Math.abs(OFFSETS[best] - u) ? i : best, 0);
	const contrast: number[] = [];
	const paired: number[] = [];
	for (let i = 0; i < cells.length; i += 2) {
		const previous = cells[Math.max(0, i - 1)];
		const next = cells[Math.min(cells.length - 1, i + 1)];
		const dx = next[0] - previous[0];
		const dy = next[1] - previous[1];
		const length = Math.hypot(dx, dy);
		if (length < 1e-6) continue;
		const x = (cells[i][0] + 0.5) * cache.field.scale;
		const y = (cells[i][1] + 0.5) * cache.field.scale;
		if (!knownPoint(cache, x, y)) continue;
		const nx = -dy / length;
		const ny = dx / length;
		const rgb = OFFSETS.map((u) => bilinear(image, x + nx * u * widthPx, y + ny * u * widthPx));
		const bg = [0, 1, 2].map((channel) => mean(far.map((j) => rgb[j][channel])));
		const overlayVector = [OVERLAY[0] - bg[0], OVERLAY[1] - bg[1], OVERLAY[2] - bg[2]];
		const denominator = overlayVector[0] ** 2 + overlayVector[1] ** 2 + overlayVector[2] ** 2 + 30;
		const alpha = rgb.map((pixel) => {
			const delta = [pixel[0] - bg[0], pixel[1] - bg[1], pixel[2] - bg[2]];
			return clamp((delta[0] * overlayVector[0] + delta[1] * overlayVector[1] + delta[2] * overlayVector[2]) / denominator, -1.5, 2.5);
		});
		contrast.push(mean(inner.map((j) => alpha[j])) - mean(outer.map((j) => alpha[j])));
		const left = Math.abs(alpha[nearestOffset(-0.35)] - alpha[nearestOffset(-0.65)]);
		const right = Math.abs(alpha[nearestOffset(0.35)] - alpha[nearestOffset(0.65)]);
		paired.push(Math.min(left, right));
	}
	if (contrast.length < 3) return { contrastFracLow: null, pairedEdgeQ25: null, points: contrast.length };
	return {
		contrastFracLow: contrast.filter((x) => x < 0.10).length / contrast.length,
		pairedEdgeQ25: quantile(paired, 0.25),
		points: contrast.length
	};
}
function acuteDegrees(axis: number, direction: number): number {
	let delta = Math.abs((((axis - direction) % Math.PI) + Math.PI) % Math.PI);
	delta = Math.min(delta, Math.PI - delta);
	return delta * 180 / Math.PI;
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
	const cachePath = take('--cache');
	const imagePath = take('--image');
	const fieldPath = take('--field');
	const outPath = take('--out');
	if (!cachePath || !imagePath || !fieldPath || !outPath) throw new Error('Usage: apgd-threefactor-leg-features.ts --cache C.json --image I --field F.bin --out O.json');
	const cache = JSON.parse(readFileSync(resolve(cachePath), 'utf8')) as CacheCourse;
	const image = decodeRgb(resolve(imagePath), cache.viewport.topPx, cache.viewport.bottomPx);
	const bytes = readFileSync(resolve(fieldPath));
	const support = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
	const teeById = new Map(cache.endpoints.tees.map((tee) => [tee.id, tee]));
	const basketById = new Map(cache.endpoints.baskets.map((basket) => [basket.id, basket]));
	const badges = cache.badges.map((badge) => ({
		id: badge.id,
		label: badge.label,
		cx: badge.cx,
		cy: badge.cy,
		rows: badge.legs
			.filter((leg) => leg.reachable)
			.map((leg) => {
				const profiles = PROFILE_WIDTHS.map((width) => profileAtWidth(image, cache, leg, width));
				const contrast = profiles.map((p) => p.contrastFracLow).filter((x): x is number => x !== null);
				const paired = profiles.map((p) => p.pairedEdgeQ25).filter((x): x is number => x !== null);
				const raw: Record<string, number | null> = {
					...supportStats(cache, support, leg),
					contrastFracLow: contrast.length ? quantile(contrast, 0.5) : null,
					pairedEdgeQ25: paired.length ? quantile(paired, 0.5) : null
				};
				if (leg.endpointId.startsWith('T')) {
					const tee = teeById.get(leg.endpointId);
					if (tee?.angle !== null && tee?.angle !== undefined) {
						const direction = Math.atan2(badge.cy - tee.y, badge.cx - tee.x);
						raw.orientationScore = Math.exp(-((acuteDegrees(tee.angle, direction) / 8) ** 2));
					} else raw.orientationScore = null;
				} else {
					raw.basketIdentity = basketById.get(leg.endpointId)?.score ?? null;
				}
				return {
					endpointId: leg.endpointId,
					raw,
					profilePoints: Math.max(0, ...profiles.map((p) => p.points))
				};
			})
	}));
	const output = {
		course: cache.course,
		profileWidths: PROFILE_WIDTHS,
		calibration: 'badge + course relative ranks; missing profile evidence is neutral',
		badges
	};
	const outputPath = resolve(outPath);
	mkdirSync(dirname(outputPath), { recursive: true });
	writeFileSync(outputPath, JSON.stringify(output, null, 2));
	console.log(`${cache.course}: badges=${badges.length} rows=${badges.reduce((sum, badge) => sum + badge.rows.length, 0)} widths=${PROFILE_WIDTHS.join('/')}`);
}

main();
