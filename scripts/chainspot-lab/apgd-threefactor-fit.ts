import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DEV = ['DashsTrack-full', 'HeritagePark-full', 'Lenard-full', 'TowneLake-full'] as const;
const VALIDATION = ['BeaverRanch-Gold', 'ColetoCreek', 'FountainHills', 'Seatac'] as const;
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
	badges: FeatureBadge[];
}
interface CacheCourse {
	course: string;
	viewport: { topPx: number; bottomPx: number };
	endpoints: {
		tees: { id: string; x: number; y: number }[];
		baskets: { id: string; x: number; y: number }[];
	};
	badges: { id: string; label: string; cx: number; cy: number }[];
	judgments?: { hole: number; trueTee: number; trueBasket: number }[];
	audit?: unknown;
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
function relativeRank(value: number | null, values: readonly number[], direction: 1 | -1): number {
	if (value === null || !Number.isFinite(value) || !values.length) return 0.5;
	const target = value * direction;
	let less = 0;
	let equal = 0;
	for (const value0 of values) {
		const test = value0 * direction;
		if (test < target - 1e-12) less++;
		else if (Math.abs(test - target) <= 1e-12) equal++;
	}
	return (less + 0.5 * equal) / values.length;
}
function calibrate(course: FeatureCourse, kind: 'T' | 'B'): CalibratedCourse {
	const names = kind === 'T' ? TEE_FEATURES : BASKET_FEATURES;
	const courseValues = new Map<string, number[]>();
	for (const name of names) courseValues.set(name, []);
	for (const badge of course.badges) {
		for (const row of badge.rows.filter((row) => row.endpointId.startsWith(kind))) {
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
			for (const name of names) {
				badgeValues.set(
					name,
					rows.map((row) => row.raw[name]).filter((value): value is number => value !== null && Number.isFinite(value))
				);
			}
			return {
				...badge,
				rows: rows.map((row) => {
					const vector: number[] = [];
					for (const name of names) {
						const badgeRank = relativeRank(row.raw[name], badgeValues.get(name) ?? [], DIRECTIONS[name]);
						const courseRank = relativeRank(row.raw[name], courseValues.get(name) ?? [], DIRECTIONS[name]);
						const rank = 0.5 * (badgeRank + courseRank);
						vector.push(rank, (rank - 0.5) ** 2);
					}
					return { ...row, vector };
				})
			};
		})
	};
}
function solveLinear(matrix: number[][], rhs: number[]): number[] {
	const n = rhs.length;
	const augmented = matrix.map((row, i) => [...row, rhs[i]]);
	for (let column = 0; column < n; column++) {
		let pivot = column;
		for (let row = column + 1; row < n; row++) {
			if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
		}
		[augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
		const divisor = Math.abs(augmented[column][column]) < 1e-12 ? 1e-12 : augmented[column][column];
		for (let j = column; j <= n; j++) augmented[column][j] /= divisor;
		for (let row = 0; row < n; row++) {
			if (row === column) continue;
			const factor = augmented[row][column];
			if (Math.abs(factor) < 1e-15) continue;
			for (let j = column; j <= n; j++) augmented[row][j] -= factor * augmented[column][j];
		}
	}
	return augmented.map((row) => row[n]);
}
function fitRidge(examples: { x: number[]; y: number }[], dimensions: number): number[] {
	const matrix = Array.from({ length: dimensions }, (_, i) =>
		Array.from({ length: dimensions }, (_, j) => i === j ? RIDGE_LAMBDA : 0)
	);
	const rhs = new Array(dimensions).fill(0);
	for (const example of examples) {
		for (let i = 0; i < dimensions; i++) {
			rhs[i] += example.x[i] * example.y;
			for (let j = 0; j < dimensions; j++) matrix[i][j] += example.x[i] * example.x[j];
		}
	}
	return solveLinear(matrix, rhs);
}
function truthId(cache: CacheCourse, label: string, kind: 'T' | 'B'): string | null {
	const judgment = cache.judgments?.find((row) => row.hole === Number(label));
	if (!judgment) return null;
	const index = kind === 'T' ? judgment.trueTee : judgment.trueBasket;
	return index >= 0 ? `${kind}${index}` : null;
}
function trainingExamples(
	courses: readonly string[],
	calibrated: Map<string, CalibratedCourse>,
	caches: Map<string, CacheCourse>,
	kind: 'T' | 'B'
): { x: number[]; y: number }[] {
	const examples: { x: number[]; y: number }[] = [];
	for (const courseName of courses) {
		const course = calibrated.get(courseName);
		const cache = caches.get(courseName);
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
				const delta = truth.vector.map((value, i) => value - rival.vector[i]);
				examples.push({ x: delta, y: 1 }, { x: delta.map((value) => -value), y: -1 });
			}
		}
	}
	return examples;
}
function scoreCourse(course: CalibratedCourse, weights: readonly number[]): CalibratedCourse {
	return {
		...course,
		badges: course.badges.map((badge) => ({
			...badge,
			rows: badge.rows.map((row) => ({ ...row, score: dot(weights, row.vector) }))
		}))
	};
}
function hungarianMax(scores: number[][]): number[] {
	const rows = scores.length;
	const realColumns = scores.reduce((max, row) => Math.max(max, row.length), 0);
	const columns = Math.max(rows, realColumns);
	const finite = scores.flat().filter(Number.isFinite);
	const floor = (finite.length ? Math.min(...finite) : 0) - 1000;
	const cost = scores.map((row) => Array.from({ length: columns }, (_, column) => -(column < row.length ? row[column] : floor)));
	const u = new Array(rows + 1).fill(0);
	const v = new Array(columns + 1).fill(0);
	const p = new Array(columns + 1).fill(0);
	const way = new Array(columns + 1).fill(0);
	for (let i = 1; i <= rows; i++) {
		p[0] = i;
		let j0 = 0;
		const minv = new Array(columns + 1).fill(Infinity);
		const used = new Array(columns + 1).fill(false);
		do {
			used[j0] = true;
			const i0 = p[j0];
			let delta = Infinity;
			let j1 = 0;
			for (let j = 1; j <= columns; j++) {
				if (used[j]) continue;
				const current = cost[i0 - 1][j - 1] - u[i0] - v[j];
				if (current < minv[j]) {
					minv[j] = current;
					way[j] = j0;
				}
				if (minv[j] < delta) {
					delta = minv[j];
					j1 = j;
				}
			}
			for (let j = 0; j <= columns; j++) {
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
	const assignment = new Array(rows).fill(-1);
	for (let j = 1; j <= columns; j++) if (p[j] > 0) assignment[p[j] - 1] = j - 1;
	return assignment.map((column) => column < realColumns ? column : -1);
}
function endpointIds(cache: CacheCourse, kind: 'T' | 'B'): string[] {
	return (kind === 'T' ? cache.endpoints.tees : cache.endpoints.baskets).map((endpoint) => endpoint.id);
}
function assignedIds(scored: CalibratedCourse, cache: CacheCourse, kind: 'T' | 'B'): string[] {
	const ids = endpointIds(cache, kind);
	const matrix = scored.badges.map((badge) => {
		const byId = new Map(badge.rows.map((row) => [row.endpointId, row.score ?? -1e6]));
		return ids.map((id) => byId.get(id) ?? -1e6);
	});
	return hungarianMax(matrix).map((column) => column >= 0 ? ids[column] : '');
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

function main(): void {
	const args = process.argv.slice(2);
	const take = (flag: string, fallback: string): string => {
		const index = args.indexOf(flag);
		if (index < 0) return fallback;
		const value = args[index + 1] ?? fallback;
		args.splice(index, 2);
		return value;
	};
	const devDir = resolve(take('--dev', '.apgd/current/dev'));
	const validationDir = resolve(take('--validation', '.apgd/current/validation'));
	const outPath = resolve(take('--out', '.apgd/current/final/validation-predictions.json'));
	const devCaches = new Map<string, CacheCourse>();
	const devTee = new Map<string, CalibratedCourse>();
	const devBasket = new Map<string, CalibratedCourse>();
	for (const name of DEV) {
		const cache = JSON.parse(readFileSync(`${devDir}/${name}.json`, 'utf8')) as CacheCourse;
		const features = JSON.parse(readFileSync(`${devDir}/${name}.features.json`, 'utf8')) as FeatureCourse;
		devCaches.set(name, cache);
		devTee.set(name, calibrate(features, 'T'));
		devBasket.set(name, calibrate(features, 'B'));
	}

	const byCourse: Record<string, unknown> = {};
	let teeLocal = 0;
	let teeAssigned = 0;
	let basketLocal = 0;
	let basketAssigned = 0;
	let teeN = 0;
	let basketN = 0;
	for (const holdout of DEV) {
		const train = DEV.filter((name) => name !== holdout);
		const teeWeights = fitRidge(trainingExamples(train, devTee, devCaches, 'T'), TEE_FEATURES.length * 2);
		const basketWeights = fitRidge(trainingExamples(train, devBasket, devCaches, 'B'), BASKET_FEATURES.length * 2);
		const cache = devCaches.get(holdout) as CacheCourse;
		const teeResult = evaluate(scoreCourse(devTee.get(holdout) as CalibratedCourse, teeWeights), cache, 'T');
		const basketResult = evaluate(scoreCourse(devBasket.get(holdout) as CalibratedCourse, basketWeights), cache, 'B');
		byCourse[holdout] = { tee: teeResult, basket: basketResult };
		teeLocal += teeResult.local;
		teeAssigned += teeResult.assigned;
		teeN += teeResult.n;
		basketLocal += basketResult.local;
		basketAssigned += basketResult.assigned;
		basketN += basketResult.n;
	}

	const teeWeights = fitRidge(trainingExamples(DEV, devTee, devCaches, 'T'), TEE_FEATURES.length * 2);
	const basketWeights = fitRidge(trainingExamples(DEV, devBasket, devCaches, 'B'), BASKET_FEATURES.length * 2);
	const predictions: Record<string, unknown> = {};
	for (const name of VALIDATION) {
		const cache = JSON.parse(readFileSync(`${validationDir}/${name}.json`, 'utf8')) as CacheCourse;
		const features = JSON.parse(readFileSync(`${validationDir}/${name}.features.json`, 'utf8')) as FeatureCourse;
		const teeScored = scoreCourse(calibrate(features, 'T'), teeWeights);
		const basketScored = scoreCourse(calibrate(features, 'B'), basketWeights);
		const teeIds = assignedIds(teeScored, cache, 'T');
		const basketIds = assignedIds(basketScored, cache, 'B');
		const rows = cache.badges.map((badge, index) => {
			const teeRanked = [...teeScored.badges[index].rows].sort((a, b) => (b.score ?? -1e6) - (a.score ?? -1e6));
			const basketRanked = [...basketScored.badges[index].rows].sort((a, b) => (b.score ?? -1e6) - (a.score ?? -1e6));
			const tee = cache.endpoints.tees.find((endpoint) => endpoint.id === teeIds[index]);
			const basket = cache.endpoints.baskets.find((endpoint) => endpoint.id === basketIds[index]);
			return {
				badgeId: badge.id,
				label: badge.label,
				badge: { xPx: badge.cx, yPx: badge.cy + cache.viewport.topPx },
				teeId: teeIds[index] || null,
				tee: tee ? { xPx: tee.x, yPx: tee.y + cache.viewport.topPx } : null,
				basketId: basketIds[index] || null,
				basket: basket ? { xPx: basket.x, yPx: basket.y + cache.viewport.topPx } : null,
				teeLocalMargin: teeRanked.length > 1 ? (teeRanked[0].score ?? 0) - (teeRanked[1].score ?? 0) : null,
				basketLocalMargin: basketRanked.length > 1 ? (basketRanked[0].score ?? 0) - (basketRanked[1].score ?? 0) : null
			};
		});
		predictions[name] = {
			audit: cache.audit,
			badges: cache.badges.length,
			tees: cache.endpoints.tees.length,
			baskets: cache.endpoints.baskets.length,
			rows
		};
	}

	const report = {
		protocol: {
			measurement: 'current src/lib/detectors/threeFactor measureThreeFactor',
			training: 'dev annotations attach truth only after measurement',
			validation: 'chainspot-corpus/validation; no truth accepted by cache adapter',
			features: { tee: TEE_FEATURES, basket: BASKET_FEATURES },
			calibration: '0.5 * badge relative rank + 0.5 * course relative rank',
			nonlinearity: 'one centered quadratic coordinate per calibrated feature',
			ridgeLambda: RIDGE_LAMBDA,
			trainingRivalsPerBadge: TRAIN_RIVALS,
			ownership: 'separate exact one-to-one Hungarian tee and basket matching',
			selection: 'single frozen specification; no validation-guided tuning'
		},
		devLoco: {
			tee: { local: teeLocal, assigned: teeAssigned, n: teeN },
			basket: { local: basketLocal, assigned: basketAssigned, n: basketN },
			byCourse
		},
		weights: { tee: teeWeights, basket: basketWeights },
		predictions
	};
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, JSON.stringify(report, null, 2));
	console.log(`DEV LOCO tee local=${teeLocal}/${teeN} assigned=${teeAssigned}/${teeN} basket local=${basketLocal}/${basketN} assigned=${basketAssigned}/${basketN}`);
	for (const name of VALIDATION) {
		const row = predictions[name] as { badges: number; tees: number; baskets: number };
		console.log(`${name}: badges=${row.badges} tees=${row.tees} baskets=${row.baskets}`);
	}
}

main();
