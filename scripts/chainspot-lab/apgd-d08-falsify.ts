import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { decodeImageFile } from '../nuthing/decode';
import { detectMapViewport, cropRows } from '../../src/lib/nuthing/viewport';
import { COURSE_CORRIDOR_WIDTH, DEFAULT_CORRIDOR_WIDTH } from '../../src/lib/nuthing/badgeOcclusion';
import type { RgbaImage } from '../../src/lib/nuthing/raster';

const OFFSETS = [-1.25, -1, -0.8, -0.65, -0.5, -0.35, -0.2, 0, 0.2, 0.35, 0.5, 0.65, 0.8, 1, 1.25] as const;
const OVERLAY = [179, 179, 179] as const;
const COURSE_IMAGES: Record<string, string> = {
	'DashsTrack-full': 'dev/DashsTrack/DashsTrack-full.jpg',
	'HeritagePark-full': 'dev/Heritage/HeritagePark-full.png',
	'Lenard-full': 'dev/Lenard/Lenard-full.PNG',
	'TowneLake-full': 'dev/TowneLake/TowneLake-full.png'
};

interface CacheLeg {
	endpointId: string;
	path: number[];
	reachable: boolean;
}
interface CachePair {
	pairId: string;
	teeId: string;
	basketId: string;
}
interface CacheBadge {
	label: string;
	cx: number;
	cy: number;
	legs: CacheLeg[];
	pairs: CachePair[];
}
interface Judgment {
	hole: number;
	truePair: CachePair | null;
	topFalse: CachePair | null;
	topFalseSharesTee: boolean;
	topFalseSharesBasket: boolean;
}
interface CacheCourse {
	course: string;
	field: { width: number; height: number; scale: number };
	endpoints: {
		tees: { id: string; x: number; y: number }[];
		baskets: { id: string; x: number; y: number }[];
	};
	badges: CacheBadge[];
	judgments: Judgment[];
}
interface Features {
	contrastFracLow: number;
	pairedEdgeQ25: number;
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
function pairCells(badge: CacheBadge, pair: CachePair): [number, number][] {
	const tee = badge.legs.find((leg) => leg.endpointId === pair.teeId);
	const basket = badge.legs.find((leg) => leg.endpointId === pair.basketId);
	if (!tee?.reachable || !basket?.reachable) return [];
	const t: [number, number][] = [];
	for (let i = 0; i < tee.path.length; i += 2) t.push([tee.path[i], tee.path[i + 1]]);
	const b: [number, number][] = [];
	for (let i = 0; i < basket.path.length; i += 2) b.push([basket.path[i], basket.path[i + 1]]);
	return t.reverse().concat(b.slice(1));
}
function knownPoint(cache: CacheCourse, x: number, y: number): boolean {
	for (const badge of cache.badges) {
		if (Math.abs(x - badge.cx) <= 30 && Math.abs(y - badge.cy) <= 26) return false;
	}
	for (const tee of cache.endpoints.tees) {
		if (Math.hypot(x - tee.x, y - tee.y) <= 24) return false;
	}
	for (const basket of cache.endpoints.baskets) {
		if (Math.hypot(x - basket.x, y - basket.y) <= 40) return false;
	}
	return true;
}
function featuresFor(image: RgbaImage, cache: CacheCourse, badge: CacheBadge, pair: CachePair, widthPx: number): Features {
	const cells = pairCells(badge, pair);
	if (cells.length < 3) return { contrastFracLow: 1, pairedEdgeQ25: 0, points: 0 };
	const contrast: number[] = [];
	const paired: number[] = [];
	const scale = cache.field.scale;
	const idx = (u: number): number => {
		let best = 0;
		for (let i = 1; i < OFFSETS.length; i++) {
			if (Math.abs(OFFSETS[i] - u) < Math.abs(OFFSETS[best] - u)) best = i;
		}
		return best;
	};
	const far = OFFSETS.map((u, i) => ({ u, i })).filter(({ u }) => Math.abs(u) >= 1).map(({ i }) => i);
	const inner = OFFSETS.map((u, i) => ({ u, i })).filter(({ u }) => Math.abs(u) <= 0.35).map(({ i }) => i);
	const outer = OFFSETS.map((u, i) => ({ u, i })).filter(({ u }) => Math.abs(u) >= 0.8).map(({ i }) => i);
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
		const left = Math.abs(alpha[idx(-0.35)] - alpha[idx(-0.65)]);
		const right = Math.abs(alpha[idx(0.35)] - alpha[idx(0.65)]);
		paired.push(Math.min(left, right));
	}
	return {
		contrastFracLow: contrast.length ? contrast.filter((x) => x < 0.10).length / contrast.length : 1,
		pairedEdgeQ25: quantile(paired, 0.25),
		points: contrast.length
	};
}

interface Counter {
	n: number;
	contrastWins: number;
	pairedWins: number;
	contrastTies: number;
	pairedTies: number;
	contrastDelta: number[];
	pairedDelta: number[];
}
function emptyCounter(): Counter {
	return { n: 0, contrastWins: 0, pairedWins: 0, contrastTies: 0, pairedTies: 0, contrastDelta: [], pairedDelta: [] };
}
function add(counter: Counter, truth: Features, rival: Features): void {
	counter.n++;
	const cd = rival.contrastFracLow - truth.contrastFracLow; // positive => truth better (lower)
	const pd = truth.pairedEdgeQ25 - rival.pairedEdgeQ25; // positive => truth better (higher)
	counter.contrastDelta.push(cd);
	counter.pairedDelta.push(pd);
	if (Math.abs(cd) < 1e-9) counter.contrastTies++;
	else if (cd > 0) counter.contrastWins++;
	if (Math.abs(pd) < 1e-9) counter.pairedTies++;
	else if (pd > 0) counter.pairedWins++;
}
function summarize(counter: Counter): Record<string, number> {
	return {
		n: counter.n,
		contrastWins: counter.contrastWins,
		contrastTies: counter.contrastTies,
		contrastHalfCredit: counter.contrastWins + counter.contrastTies * 0.5,
		contrastMedianDelta: quantile(counter.contrastDelta, 0.5),
		pairedWins: counter.pairedWins,
		pairedTies: counter.pairedTies,
		pairedHalfCredit: counter.pairedWins + counter.pairedTies * 0.5,
		pairedMedianDelta: quantile(counter.pairedDelta, 0.5)
	};
}

function main(): void {
	const args = process.argv.slice(2);
	const take = (flag: string, fallback: string): string => {
		const i = args.indexOf(flag);
		if (i < 0) return fallback;
		const value = args[i + 1];
		args.splice(i, 2);
		return value;
	};
	const cacheDir = resolve(take('--cache', '/tmp/apgd-d08-cache'));
	const corpusRoot = resolve(take('--corpus', '../chainspot-corpus'));
	const out = resolve(take('--out', '/tmp/apgd-d08-falsification.json'));
	const total = emptyCounter();
	const byCourse: Record<string, Counter> = {};
	const byRivalry: Record<string, Counter> = {
		sharesTee: emptyCounter(),
		sharesBasket: emptyCounter(),
		sharesNeither: emptyCounter()
	};
	const examples: unknown[] = [];
	for (const course of Object.keys(COURSE_IMAGES)) {
		const cache = JSON.parse(readFileSync(`${cacheDir}/${course}.json`, 'utf8')) as CacheCourse;
		const full = decodeImageFile(resolve(corpusRoot, COURSE_IMAGES[course]));
		const image = cropRows(full, detectMapViewport(full));
		const widthPx = COURSE_CORRIDOR_WIDTH[course] ?? DEFAULT_CORRIDOR_WIDTH;
		const counter = emptyCounter();
		byCourse[course] = counter;
		for (const judgment of cache.judgments) {
			if (!judgment.truePair || !judgment.topFalse) continue;
			const badge = cache.badges.find((b) => Number(b.label) === judgment.hole);
			if (!badge) continue;
			const truth = featuresFor(image, cache, badge, judgment.truePair, widthPx);
			const rival = featuresFor(image, cache, badge, judgment.topFalse, widthPx);
			if (!truth.points || !rival.points) continue;
			add(total, truth, rival);
			add(counter, truth, rival);
			const rivalry = judgment.topFalseSharesTee
				? 'sharesTee'
				: judgment.topFalseSharesBasket
					? 'sharesBasket'
					: 'sharesNeither';
			add(byRivalry[rivalry], truth, rival);
			examples.push({ course, hole: judgment.hole, rivalry, truth, rival });
		}
	}
	const result = {
		protocol: {
			rivals: 'actual D08 strongest false competitor from pair-matrix cache',
			contrastDirection: 'lower contrastFracLow is better',
			pairedDirection: 'higher pairedEdgeQ25 is better',
			objectMask: 'detected badges/tees/baskets only; no truth coordinates',
			rendersRetained: 0
		},
		total: summarize(total),
		byCourse: Object.fromEntries(Object.entries(byCourse).map(([k, v]) => [k, summarize(v)])),
		byRivalry: Object.fromEntries(Object.entries(byRivalry).map(([k, v]) => [k, summarize(v)])),
		examples
	};
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, JSON.stringify(result, null, 2));
	const s = result.total;
	console.log(`REAL-D08 n=${s.n} contrast=${s.contrastWins}+${s.contrastTies}ties paired=${s.pairedWins}+${s.pairedTies}ties`);
	for (const [course, row] of Object.entries(result.byCourse)) {
		console.log(`${course}: n=${row.n} contrast=${row.contrastWins}+${row.contrastTies}t paired=${row.pairedWins}+${row.pairedTies}t`);
	}
	for (const [kind, row] of Object.entries(result.byRivalry)) {
		console.log(`${kind}: n=${row.n} contrast=${row.contrastWins}+${row.contrastTies}t paired=${row.pairedWins}+${row.pairedTies}t`);
	}
}

main();
