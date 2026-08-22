import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { decodeImageFile } from '../nuthing/decode';

const DEV = ['DashsTrack-full', 'HeritagePark-full', 'Lenard-full', 'TowneLake-full'] as const;
const VALIDATION = ['BeaverRanch-Gold', 'ColetoCreek', 'FountainHills', 'Seatac'] as const;
const VALIDATION_IMAGES: Record<string, string> = {
	'BeaverRanch-Gold': 'validation/BeaverRanch-Gold/clean/BeaverRanch-Gold-full.PNG',
	'ColetoCreek': 'validation/ColetoCreek/clean/ColetoCreek-full.PNG',
	'FountainHills': 'validation/FountainHills/clean/FountainHills-full.PNG',
	'Seatac': 'validation/Seatac/clean/Seatac-full.PNG'
};
const COMMON = ['supportMean', 'supportQ25', 'supportWorst', 'supportFracLow', 'contrastFracLow', 'pairedEdgeQ25'] as const;
const TEE_FEATURES = [...COMMON, 'orientationScore'] as const;
const BASKET_FEATURES = [...COMMON, 'basketIdentity'] as const;
const DIRECTIONS: Record<string, 1 | -1> = {
	supportMean: 1,
	supportQ25: 1,
	supportWorst: 1,
	supportFracLow: -1,
	contrastFracLow: -1,
	pairedEdgeQ25: 1,
	orientationScore: 1,
	basketIdentity: 1
};
const RIDGE_LAMBDA = 2;
const TRAIN_RIVALS = 8;

interface RawRow {
	endpointId: string;
	raw: Record<string, number | null>;
	profilePoints: number;
}
interface FeatureBadge {
	id: string;
	label: string;
	cx: number;
	cy: number;
	rows: RawRow[];
}
interface FeatureCourse {
	course: string;
	profileWidths: number[];
	badges: FeatureBadge[];
}
interface CacheLeg {
	endpointId: string;
	path: number[];
	reachable: boolean;
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
		tees: { id: string; x: number; y: number }[];
		baskets: { id: string; x: number; y: number }[];
	};
	badges: CacheBadge[];
	judgments?: { hole: number; trueTee: number; trueBasket: number }[];
}
interface CalibratedRow extends RawRow {
	vector: number[];
	score?: number;
}
interface CalibratedBadge extends Omit<FeatureBadge, 'rows'> {
	rows: CalibratedRow[];
}
interface CalibratedCourse {
	course: string;
	badges: CalibratedBadge[];
}

function dot(a: readonly number[], b: readonly number[]): number {
	let sum = 0;
	for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
	return sum;
}
function rank(value: number | null, values: readonly number[], direction: 1 | -1): number {
	if (value === null || !Number.isFinite(value) || !values.length) return 0.5;
	const target = value * direction;
	let less = 0;
	let equal = 0;
	for (const x of values) {
		const y = x * direction;
		if (y < target - 1e-12) less++;
		else if (Math.abs(y - target) <= 1e-12) equal++;
	}
	return (less + 0.5 * equal) / values.length;
}
function calibrate(course: FeatureCourse, kind: 'T' | 'B'): CalibratedCourse {
	const names = kind === 'T' ? TEE_FEATURES : BASKET_FEATURES;
	const courseValues = new Map<string, number[]>();
	for (const name of names) courseValues.set(name, []);
	for (const badge of course.badges) {
		for (const row of badge.rows.filter((r) => r.endpointId.startsWith(kind))) {
			for (const name of names) {
				const value = row.raw[name];
				if (value !== null && Number.isFinite(value)) courseValues.get(name)?.push(value);
			}
		}
	}
	return {
		course: course.course,
		badges: course.badges.map((badge) => {
			const rows = badge.rows.filter((row) => row.endpointId.startsWith(kind));
			const badgeValues = new Map<string, number[]>();
			for (const name of names) badgeValues.set(name, rows.map((r) => r.raw[name]).filter((x): x is number => x !== null && Number.isFinite(x)));
			return {
				...badge,
				rows: rows.map((row) => {
					const vector: number[] = [];
					for (const name of names) {
						const b = rank(row.raw[name], badgeValues.get(name) ?? [], DIRECTIONS[name]);
						const c = rank(row.raw[name], courseValues.get(name) ?? [], DIRECTIONS[name]);
						const r = 0.5 * (b + c);
						vector.push(r, (r - 0.5) * (r - 0.5));
					}
					return { ...row, vector };
				})
			};
		})
	};
}
function solveLinear(a: number[][], b: number[]): number[] {
	const n = b.length;
	const m = a.map((row, i) => [...row, b[i]]);
	for (let col = 0; col < n; col++) {
		let pivot = col;
		for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
		[m[col], m[pivot]] = [m[pivot], m[col]];
		const div = Math.abs(m[col][col]) < 1e-12 ? 1e-12 : m[col][col];
		for (let j = col; j <= n; j++) m[col][j] /= div;
		for (let r = 0; r < n; r++) {
			if (r === col) continue;
			const f = m[r][col];
			if (Math.abs(f) < 1e-15) continue;
			for (let j = col; j <= n; j++) m[r][j] -= f * m[col][j];
		}
	}
	return m.map((row) => row[n]);
}
function fitRidge(examples: { x: number[]; y: number }[], dims: number): number[] {
	const a = Array.from({ length: dims }, (_, i) => Array.from({ length: dims }, (_, j) => i === j ? RIDGE_LAMBDA : 0));
	const b = new Array(dims).fill(0);
	for (const ex of examples) {
		for (let i = 0; i < dims; i++) {
			b[i] += ex.x[i] * ex.y;
			for (let j = 0; j < dims; j++) a[i][j] += ex.x[i] * ex.x[j];
		}
	}
	return solveLinear(a, b);
}
function truthId(cache: CacheCourse, label: string, kind: 'T' | 'B'): string | null {
	const j = cache.judgments?.find((x) => x.hole === Number(label));
	if (!j) return null;
	const index = kind === 'T' ? j.trueTee : j.trueBasket;
	return index >= 0 ? `${kind}${index}` : null;
}
function trainingExamples(courses: string[], calibrated: Map<string, CalibratedCourse>, caches: Map<string, CacheCourse>, kind: 'T' | 'B'): { x: number[]; y: number }[] {
	const out: { x: number[]; y: number }[] = [];
	for (const name of courses) {
		const course = calibrated.get(name);
		const cache = caches.get(name);
		if (!course || !cache) continue;
		for (const badge of course.badges) {
			const want = truthId(cache, badge.label, kind);
			const truth = badge.rows.find((row) => row.endpointId === want);
			if (!truth) continue;
			const rivals = badge.rows
				.filter((row) => row.endpointId !== want)
				.sort((a, b) => (b.raw.supportWorst ?? -1) - (a.raw.supportWorst ?? -1))
				.slice(0, TRAIN_RIVALS);
			for (const rival of rivals) {
				const d = truth.vector.map((x, i) => x - rival.vector[i]);
				out.push({ x: d, y: 1 }, { x: d.map((x) => -x), y: -1 });
			}
		}
	}
	return out;
}
function scoreCourse(course: CalibratedCourse, weights: number[]): CalibratedCourse {
	return {
		...course,
		badges: course.badges.map((badge) => ({
			...badge,
			rows: badge.rows.map((row) => ({ ...row, score: dot(weights, row.vector) }))
		}))
	};
}
function hungarianMax(scores: number[][]): number[] {
	const n = scores.length;
	const realM = scores.reduce((m, row) => Math.max(m, row.length), 0);
	const m = Math.max(n, realM);
	const minScore = Math.min(0, ...scores.flat().filter(Number.isFinite)) - 1000;
	const cost = scores.map((row) => Array.from({ length: m }, (_, j) => -(j < row.length ? row[j] : minScore)));
	const u = new Array(n + 1).fill(0);
	const v = new Array(m + 1).fill(0);
	const p = new Array(m + 1).fill(0);
	const way = new Array(m + 1).fill(0);
	for (let i = 1; i <= n; i++) {
		p[0] = i;
		let j0 = 0;
		const minv = new Array(m + 1).fill(Infinity);
		const used = new Array(m + 1).fill(false);
		do {
			used[j0] = true;
			const i0 = p[j0];
			let delta = Infinity;
			let j1 = 0;
			for (let j = 1; j <= m; j++) {
				if (used[j]) continue;
				const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
				if (cur < minv[j]) {
					minv[j] = cur;
					way[j] = j0;
				}
				if (minv[j] < delta) {
					delta = minv[j];
					j1 = j;
				}
			}
			for (let j = 0; j <= m; j++) {
				if (used[j]) {
					u[p[j]] += delta;
					v[j] -= delta;
				} else minv[j] -= delta;
			}
			j0 = j1;
		} while (p[j0] !== 0);
		do {
			const j1 = way[j0];
			p[j0] = p[j1];
			j0 = j1;
		} while (j0 !== 0);
	}
	const assignment = new Array(n).fill(-1);
	for (let j = 1; j <= m; j++) if (p[j] > 0) assignment[p[j] - 1] = j - 1;
	return assignment.map((j) => j < realM ? j : -1);
}
function endpointIds(cache: CacheCourse, kind: 'T' | 'B'): string[] {
	return (kind === 'T' ? cache.endpoints.tees : cache.endpoints.baskets).map((x) => x.id);
}
function assignedIds(scored: CalibratedCourse, cache: CacheCourse, kind: 'T' | 'B'): string[] {
	const ids = endpointIds(cache, kind);
	const matrix = scored.badges.map((badge) => {
		const byId = new Map(badge.rows.map((row) => [row.endpointId, row.score ?? -1e6]));
		return ids.map((id) => byId.get(id) ?? -1e6);
	});
	return hungarianMax(matrix).map((col) => col >= 0 ? ids[col] : '');
}
function evaluate(scored: CalibratedCourse, cache: CacheCourse, kind: 'T' | 'B'): { local: number; assigned: number; n: number } {
	const assigned = assignedIds(scored, cache, kind);
	let local = 0;
	let global = 0;
	let n = 0;
	for (let i = 0; i < scored.badges.length; i++) {
		const badge = scored.badges[i];
		const want = truthId(cache, badge.label, kind);
		if (!want) continue;
		n++;
		const top = [...badge.rows].sort((a, b) => (b.score ?? -1e6) - (a.score ?? -1e6))[0]?.endpointId;
		if (top === want) local++;
		if (assigned[i] === want) global++;
	}
	return { local, assigned: global, n };
}
function hsvColor(index: number): [number, number, number] {
	const h = ((index * 137.508) % 360) / 60;
	const c = 220;
	const x = c * (1 - Math.abs((h % 2) - 1));
	let rgb: [number, number, number];
	if (h < 1) rgb = [c, x, 0];
	else if (h < 2) rgb = [x, c, 0];
	else if (h < 3) rgb = [0, c, x];
	else if (h < 4) rgb = [0, x, c];
	else if (h < 5) rgb = [x, 0, c];
	else rgb = [c, 0, x];
	return rgb.map((v) => Math.round(v + 25)) as [number, number, number];
}
function mark(png: PNG, x: number, y: number, color: [number, number, number], radius = 2): void {
	for (let dy = -radius; dy <= radius; dy++) {
		for (let dx = -radius; dx <= radius; dx++) {
			const xx = Math.round(x + dx);
			const yy = Math.round(y + dy);
			if (xx < 0 || xx >= png.width || yy < 0 || yy >= png.height) continue;
			const p = (yy * png.width + xx) * 4;
			png.data[p] = color[0];
			png.data[p + 1] = color[1];
			png.data[p + 2] = color[2];
			png.data[p + 3] = 255;
		}
	}
}
function renderPrediction(imagePath: string, cache: CacheCourse, teeIds: string[], basketIds: string[], outPath: string): void {
	const full = decodeImageFile(imagePath);
	const png = new PNG({ width: full.width, height: full.height });
	png.data.set(full.data);
	const top = cache.viewport?.top ?? 0;
	const scale = cache.field.scale;
	for (let i = 0; i < cache.badges.length; i++) {
		const badge = cache.badges[i];
		const color = hsvColor(Number(badge.label) || i + 1);
		for (const endpointId of [teeIds[i], basketIds[i]]) {
			const leg = badge.legs.find((x) => x.endpointId === endpointId);
			if (!leg) continue;
			for (let j = 0; j < leg.path.length; j += 2) {
				mark(png, (leg.path[j] + 0.5) * scale, (leg.path[j + 1] + 0.5) * scale + top, color, 1);
			}
		}
		mark(png, badge.cx, badge.cy + top, [255, 20, 20], 4);
		const tee = cache.endpoints.tees.find((x) => x.id === teeIds[i]);
		const basket = cache.endpoints.baskets.find((x) => x.id === basketIds[i]);
		if (tee) mark(png, tee.x, tee.y + top, [20, 255, 20], 5);
		if (basket) mark(png, basket.x, basket.y + top, [40, 120, 255], 5);
	}
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, PNG.sync.write(png));
}

function main(): void {
	const args = process.argv.slice(2);
	const take = (flag: string, fallback: string): string => {
		const i = args.indexOf(flag);
		if (i < 0) return fallback;
		const value = args[i + 1] ?? fallback;
		args.splice(i, 2);
		return value;
	};
	const devDir = resolve(take('--dev', '.apgd/dev'));
	const validationDir = resolve(take('--validation', '.apgd/validation'));
	const corpus = resolve(take('--corpus', 'chainspot-corpus'));
	const outDir = resolve(take('--out', '.apgd/final'));
	mkdirSync(outDir, { recursive: true });
	const devFeatures = new Map<string, FeatureCourse>();
	const devCaches = new Map<string, CacheCourse>();
	const devTee = new Map<string, CalibratedCourse>();
	const devBasket = new Map<string, CalibratedCourse>();
	for (const name of DEV) {
		const feature = JSON.parse(readFileSync(`${devDir}/${name}.features.json`, 'utf8')) as FeatureCourse;
		const cache = JSON.parse(readFileSync(`${devDir}/${name}.json`, 'utf8')) as CacheCourse;
		devFeatures.set(name, feature);
		devCaches.set(name, cache);
		devTee.set(name, calibrate(feature, 'T'));
		devBasket.set(name, calibrate(feature, 'B'));
	}
	const loco: Record<string, unknown> = {};
	let teeLocal = 0, teeAssigned = 0, basketLocal = 0, basketAssigned = 0, total = 0;
	for (const holdout of DEV) {
		const train = DEV.filter((x) => x !== holdout);
		const teeDims = TEE_FEATURES.length * 2;
		const basketDims = BASKET_FEATURES.length * 2;
		const tw = fitRidge(trainingExamples(train, devTee, devCaches, 'T'), teeDims);
		const bw = fitRidge(trainingExamples(train, devBasket, devCaches, 'B'), basketDims);
		const cache = devCaches.get(holdout) as CacheCourse;
		const te = evaluate(scoreCourse(devTee.get(holdout) as CalibratedCourse, tw), cache, 'T');
		const be = evaluate(scoreCourse(devBasket.get(holdout) as CalibratedCourse, bw), cache, 'B');
		loco[holdout] = { tee: te, basket: be };
		teeLocal += te.local; teeAssigned += te.assigned; basketLocal += be.local; basketAssigned += be.assigned; total += Math.min(te.n, be.n);
	}
	const teeWeights = fitRidge(trainingExamples([...DEV], devTee, devCaches, 'T'), TEE_FEATURES.length * 2);
	const basketWeights = fitRidge(trainingExamples([...DEV], devBasket, devCaches, 'B'), BASKET_FEATURES.length * 2);
	const predictions: Record<string, unknown> = {};
	for (const name of VALIDATION) {
		const feature = JSON.parse(readFileSync(`${validationDir}/${name}.features.json`, 'utf8')) as FeatureCourse;
		const cache = JSON.parse(readFileSync(`${validationDir}/${name}.json`, 'utf8')) as CacheCourse;
		const teeScored = scoreCourse(calibrate(feature, 'T'), teeWeights);
		const basketScored = scoreCourse(calibrate(feature, 'B'), basketWeights);
		const teeIds = assignedIds(teeScored, cache, 'T');
		const basketIds = assignedIds(basketScored, cache, 'B');
		const rows = cache.badges.map((badge, i) => {
			const teeBadge = teeScored.badges[i];
			const basketBadge = basketScored.badges[i];
			const teeRanked = [...teeBadge.rows].sort((a, b) => (b.score ?? -1e6) - (a.score ?? -1e6));
			const basketRanked = [...basketBadge.rows].sort((a, b) => (b.score ?? -1e6) - (a.score ?? -1e6));
			const tee = cache.endpoints.tees.find((x) => x.id === teeIds[i]);
			const basket = cache.endpoints.baskets.find((x) => x.id === basketIds[i]);
			const top = cache.viewport?.top ?? 0;
			return {
				badgeId: badge.id ?? `badge-${i}`,
				label: badge.label,
				badge: { xPx: badge.cx, yPx: badge.cy + top },
				teeId: teeIds[i] || null,
				tee: tee ? { xPx: tee.x, yPx: tee.y + top } : null,
				basketId: basketIds[i] || null,
				basket: basket ? { xPx: basket.x, yPx: basket.y + top } : null,
				teeLocalMargin: teeRanked.length > 1 ? (teeRanked[0].score ?? 0) - (teeRanked[1].score ?? 0) : null,
				basketLocalMargin: basketRanked.length > 1 ? (basketRanked[0].score ?? 0) - (basketRanked[1].score ?? 0) : null
			};
		});
		predictions[name] = {
			badges: cache.badges.length,
			tees: cache.endpoints.tees.length,
			baskets: cache.endpoints.baskets.length,
			rows
		};
		renderPrediction(resolve(corpus, VALIDATION_IMAGES[name]), cache, teeIds, basketIds, `${outDir}/${name}-prediction.png`);
	}
	const report = {
		protocol: {
			training: 'real D08 dev candidates only',
			validation: 'sealed chainspot-corpus/validation; no truth loaded',
			model: 'separate tee/basket pairwise Ridge, badge+course relative ranks, centered quadratic per signal',
			ridgeLambda: RIDGE_LAMBDA,
			trainingRivalsPerBadge: TRAIN_RIVALS,
			profileWidthsPx: [30, 37, 40],
			selection: 'single frozen specification; LOCO reported but not used to select another configuration'
		},
		devLoco: {
			total,
			teeLocal,
			teeAssigned,
			basketLocal,
			basketAssigned,
			byCourse: loco
		},
		weights: { tee: teeWeights, basket: basketWeights },
		predictions
	};
	writeFileSync(`${outDir}/validation-predictions.json`, JSON.stringify(report, null, 2));
	const md = [
		'# APGD dev-fit -> sealed validation',
		'',
		'One frozen specification. Validation truth was not loaded or available to this process.',
		'',
		`Dev LOCO tee local ${teeLocal}/${total}; tee one-to-one ${teeAssigned}/${total}; basket local ${basketLocal}/${total}; basket one-to-one ${basketAssigned}/${total}.`,
		'',
		...VALIDATION.map((name) => {
			const p = predictions[name] as { badges: number; tees: number; baskets: number };
			return `- ${name}: badges=${p.badges}, tees=${p.tees}, baskets=${p.baskets}; final image ${name}-prediction.png`;
		}),
		'',
		'Validation images are predictions only; no accuracy is claimed without the sealed evaluator.'
	].join('\n');
	writeFileSync(`${outDir}/validation-report.md`, md);
	console.log(md);
}

main();
