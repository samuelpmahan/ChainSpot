import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { decodeImageFile } from '../nuthing/decode';
import { detectMapViewport, cropRows } from '../../src/lib/nuthing/viewport';
import type { RgbaImage } from '../../src/lib/nuthing/raster';

const OFFSETS = [-1.25, -1, -0.8, -0.65, -0.5, -0.35, -0.2, 0, 0.2, 0.35, 0.5, 0.65, 0.8, 1, 1.25] as const;
const PROFILE_WIDTHS = [30, 37, 40] as const;
const OVERLAY = [179, 179, 179] as const;
const SUPPORT_TAU = 0.5;
const WORST_WINDOW_SRC_PX = 45;

interface CacheLeg {
	endpointId: string;
	path: number[];
	reachable: boolean;
	geodesic?: number | null;
}
interface CacheBadge {
	id?: string;
	label: string;
	cx: number;
	cy: number;
	legs: CacheLeg[];
}
interface CacheCourse {
	course: string;
	field: { width: number; height: number; scale: number };
	viewport?: { top: number; bottom: number };
	endpoints: {
		tees: { id: string; x: number; y: number; angle?: number | null; tier?: string }[];
		baskets: { id: string; x: number; y: number; score?: number }[];
	};
	badges: CacheBadge[];
}
interface ProfileResult {
	contrastFracLow: number | null;
	pairedEdgeQ25: number | null;
	points: number;
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
function median(values: readonly number[]): number {
	return quantile(values, 0.5);
}
function clamp(v: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, v));
}
function bilinear(image: RgbaImage, x: number, y: number): [number, number, number] {
	x = clamp(x, 0, image.width - 1.001);
	y = clamp(y, 0, image.height - 1.001);
	const x0 = Math.floor(x);
	const y0 = Math.floor(y);
	const x1 = Math.min(image.width - 1, x0 + 1);
	const y1 = Math.min(image.height - 1, y0 + 1);
	const dx = x - x0;
	const dy = y - y0;
	const read = (xx: number, yy: number, c: number): number => image.data[(yy * image.width + xx) * 4 + c];
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
function profileAtWidth(image: RgbaImage, cache: CacheCourse, leg: CacheLeg, widthPx: number): ProfileResult {
	const cells: [number, number][] = [];
	for (let i = 0; i < leg.path.length; i += 2) cells.push([leg.path[i], leg.path[i + 1]]);
	if (cells.length < 3) return { contrastFracLow: null, pairedEdgeQ25: null, points: 0 };
	const scale = cache.field.scale;
	const far = OFFSETS.map((u, i) => ({ u, i })).filter(({ u }) => Math.abs(u) >= 1).map(({ i }) => i);
	const inner = OFFSETS.map((u, i) => ({ u, i })).filter(({ u }) => Math.abs(u) <= 0.35).map(({ i }) => i);
	const outer = OFFSETS.map((u, i) => ({ u, i })).filter(({ u }) => Math.abs(u) >= 0.8).map(({ i }) => i);
	const index = (u: number): number => OFFSETS.reduce((best, x, i) => Math.abs(x - u) < Math.abs(OFFSETS[best] - u) ? i : best, 0);
	const contrast: number[] = [];
	const paired: number[] = [];
	for (let i = 0; i < cells.length; i += 2) {
		const prev = cells[Math.max(0, i - 1)];
		const next = cells[Math.min(cells.length - 1, i + 1)];
		const dx = next[0] - prev[0];
		const dy = next[1] - prev[1];
		const len = Math.hypot(dx, dy);
		if (len < 1e-6) continue;
		const x = (cells[i][0] + 0.5) * scale;
		const y = (cells[i][1] + 0.5) * scale;
		if (!knownPoint(cache, x, y)) continue;
		const nx = -dy / len;
		const ny = dx / len;
		const rgb = OFFSETS.map((u) => bilinear(image, x + nx * u * widthPx, y + ny * u * widthPx));
		const bg = [0, 1, 2].map((c) => mean(far.map((j) => rgb[j][c])));
		const o = [OVERLAY[0] - bg[0], OVERLAY[1] - bg[1], OVERLAY[2] - bg[2]];
		const den = o[0] * o[0] + o[1] * o[1] + o[2] * o[2] + 30;
		const alpha = rgb.map((p) => {
			const dd = [p[0] - bg[0], p[1] - bg[1], p[2] - bg[2]];
			return clamp((dd[0] * o[0] + dd[1] * o[1] + dd[2] * o[2]) / den, -1.5, 2.5);
		});
		contrast.push(mean(inner.map((j) => alpha[j])) - mean(outer.map((j) => alpha[j])));
		const left = Math.abs(alpha[index(-0.35)] - alpha[index(-0.65)]);
		const right = Math.abs(alpha[index(0.35)] - alpha[index(0.65)]);
		paired.push(Math.min(left, right));
	}
	if (contrast.length < 3) return { contrastFracLow: null, pairedEdgeQ25: null, points: contrast.length };
	return {
		contrastFracLow: contrast.filter((x) => x < 0.10).length / contrast.length,
		pairedEdgeQ25: quantile(paired, 0.25),
		points: contrast.length
	};
}
function supportStats(cache: CacheCourse, support: Float32Array, leg: CacheLeg): Record<string, number> {
	const samples: number[] = [];
	for (let i = 0; i < leg.path.length; i += 2) samples.push(support[leg.path[i + 1] * cache.field.width + leg.path[i]] ?? 0);
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
function acuteAxisDegrees(axis: number, direction: number): number {
	let d = Math.abs((((axis - direction) % Math.PI) + Math.PI) % Math.PI);
	d = Math.min(d, Math.PI - d);
	return d * 180 / Math.PI;
}

function main(): void {
	const args = process.argv.slice(2);
	const take = (flag: string): string | null => {
		const i = args.indexOf(flag);
		if (i < 0) return null;
		const value = args[i + 1] ?? null;
		args.splice(i, 2);
		return value;
	};
	const cachePath = take('--cache');
	const imagePath = take('--image');
	const fieldPath = take('--field');
	const outPath = take('--out');
	if (!cachePath || !imagePath || !fieldPath || !outPath) throw new Error('Usage: apgd-leg-features.ts --cache C.json --image I.png --field F.bin --out O.json');
	const cache = JSON.parse(readFileSync(resolve(cachePath), 'utf8')) as CacheCourse;
	const full = decodeImageFile(resolve(imagePath));
	const image = cropRows(full, detectMapViewport(full));
	const fieldBuf = readFileSync(resolve(fieldPath));
	const support = new Float32Array(fieldBuf.buffer.slice(fieldBuf.byteOffset, fieldBuf.byteOffset + fieldBuf.byteLength));
	const teeById = new Map(cache.endpoints.tees.map((x) => [x.id, x]));
	const basketById = new Map(cache.endpoints.baskets.map((x) => [x.id, x]));
	const badges = cache.badges.map((badge) => {
		const rows = badge.legs.filter((leg) => leg.reachable).map((leg) => {
			const profiles = PROFILE_WIDTHS.map((width) => profileAtWidth(image, cache, leg, width));
			const validContrast = profiles.map((p) => p.contrastFracLow).filter((x): x is number => x !== null);
			const validPaired = profiles.map((p) => p.pairedEdgeQ25).filter((x): x is number => x !== null);
			const raw: Record<string, number | null> = {
				...supportStats(cache, support, leg),
				contrastFracLow: validContrast.length ? median(validContrast) : null,
				pairedEdgeQ25: validPaired.length ? median(validPaired) : null
			};
			if (leg.endpointId.startsWith('T')) {
				const tee = teeById.get(leg.endpointId);
				if (tee?.angle !== null && tee?.angle !== undefined) {
					const direction = Math.atan2(badge.cy - tee.y, badge.cx - tee.x);
					const degrees = acuteAxisDegrees(tee.angle, direction);
					raw.orientationScore = Math.exp(-((degrees / 8) ** 2));
				} else raw.orientationScore = null;
			} else {
				const basket = basketById.get(leg.endpointId);
				raw.basketIdentity = basket?.score ?? null;
			}
			return { endpointId: leg.endpointId, raw, profilePoints: Math.max(...profiles.map((p) => p.points), 0) };
		});
		return { id: badge.id ?? `badge-${badge.label}`, label: badge.label, cx: badge.cx, cy: badge.cy, rows };
	});
	mkdirSync(dirname(resolve(outPath)), { recursive: true });
	writeFileSync(resolve(outPath), JSON.stringify({
		course: cache.course,
		profileWidths: PROFILE_WIDTHS,
		calibration: 'consumer computes badge/course relative ranks; null profile evidence is neutral',
		badges
	}, null, 2));
	console.log(`${cache.course}: badges=${badges.length} rows=${badges.reduce((sum, b) => sum + b.rows.length, 0)} widths=${PROFILE_WIDTHS.join('/')}`);
}

main();
