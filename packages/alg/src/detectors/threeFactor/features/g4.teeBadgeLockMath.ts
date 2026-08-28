/**
 * Pure tee↔badge ownership math for the G4 teeBadgeLock deviation.
 *
 * The path named `RawPairEvidence.teeLeg` is legacy pathfinder testimony in
 * badge→tee order.  This feature deliberately treats it as opaque testimony,
 * reads no basket-side property, and reverses the exact sampled points once
 * at the public seam.  Everything below operates on that tee→badge sequence;
 * it never interpolates, smooths, or refits a route.
 */

export type TeeBadgePoint = readonly [number, number];
export type TeeBadgePath = readonly TeeBadgePoint[];

/** The deliberately narrow adapter input.  Do not widen this to the whole
 * RawPairEvidence shape: basket geometry and legacy score fields are outside
 * this feature's evidence custody. */
export interface TeeBadgePathInput {
	readonly badgeId: string;
	readonly teeId: string;
	readonly teeLeg: { readonly path: TeeBadgePath };
}

/** Alias used by callers that want the raw-row name to remain explicit. */
export type TeeBadgeLockRawPairRow = TeeBadgePathInput;

export interface TeeBadgePathCandidate {
	readonly badgeId: string;
	readonly teeId: string;
	readonly teeBadgePath: TeeBadgePath;
	/** Detector coordinates are optional on the pure path shape.  The
	 * production scorer supplies them from measurement.badges/tees; direct
	 * isolated math tests fall back to route endpoints. */
	readonly teeXPx?: number;
	readonly teeYPx?: number;
	readonly badgeXPx?: number;
	readonly badgeYPx?: number;
}

export interface TeeBadgeLockMathKnobs {
	/** Source provenance: measurement.parameters.alignmentPower. */
	readonly alignmentPower: number;
	/** Source provenance: measurement.parameters.worstWindowSrcPx. */
	readonly worstWindowSrcPx: number;
	/** Source provenance: resolved scoring.minWindowCells. */
	readonly minWindowCells: number;
	/** Source provenance: resolved scoring.teeOrientationSigmaDeg. */
	readonly teeOrientationSigmaDeg: number;
}

export interface TeeBadgeLockSupportField {
	readonly width: number;
	readonly height: number;
	readonly scale: number;
	readonly support: ArrayLike<number>;
	readonly bestTheta: ArrayLike<number>;
}

export type TeeBadgeAxisSource =
	| 'TeeEvidence.pad.minAreaPose.angleRad'
	| 'TeeEvidence.angleRad'
	| 'TeeEvidence.pad.angleRad'
	| 'UNKNOWN';

export interface TeeBadgeLockScoredCandidate extends TeeBadgePathCandidate {
	readonly score: number;
	readonly weakAlignedSupport: number;
	readonly pathEfficiency: number;
	readonly axisErrorDeg: number | 'UNKNOWN';
	readonly axisFactor: number;
	readonly axisSource: TeeBadgeAxisSource;
	readonly windowCells: number;
	readonly routedLengthPx: number;
	readonly chordPx: number;
	readonly runnerUpMargin: number | null;
}

export interface TeeBadgeBadgeOrder {
	readonly detId: string;
	readonly label?: string | null;
	readonly cxPx?: number;
	readonly cyPx?: number;
}

export interface TeeBadgeTeeOrder {
	readonly detId: string;
	readonly tier?: string;
	readonly xPx?: number;
	readonly yPx?: number;
	readonly angleRad?: number | null;
	readonly pad?: {
		readonly angleRad?: number | null;
		readonly minAreaPose?: { readonly angleRad?: number | null };
	};
}

export interface TeeBadgeLockResult {
	readonly candidates: readonly TeeBadgeLockScoredCandidate[];
	readonly locks: readonly TeeBadgeLockScoredCandidate[];
	readonly unmatchedBadgeIds: readonly string[];
	readonly unusedTeeIds: readonly string[];
}

export interface TeeBadgeLockEvidenceLock extends TeeBadgeLockScoredCandidate {
	readonly tier: 'visible' | 'recovered';
	readonly hole?: number;
}

export interface TeeBadgeLockEvidence extends TeeBadgeLockResult {
	readonly coordinateFrame: 'canonical-raster';
	readonly basketEvidenceRead: false;
	readonly corridorWidthPx: number | 'UNKNOWN';
	readonly corridorWidthPxProvenance: string;
	readonly locks: readonly TeeBadgeLockEvidenceLock[];
}

const UNKNOWN_AXIS: TeeBadgeAxisSource = 'UNKNOWN';

function finite(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function positiveFinite(value: unknown): value is number {
	return finite(value) && value > 0;
}

function samePoint(a: readonly [number, number], b: readonly [number, number]): boolean {
	return Object.is(a[0], b[0]) && Object.is(a[1], b[1]);
}

function clonePath(path: TeeBadgePath): TeeBadgePoint[] {
	if (!Array.isArray(path)) throw new Error('teeBadgeLock: teeLeg.path must be an array.');
	return path.map((point, index) => {
		if (!Array.isArray(point) || point.length < 2 || !finite(point[0]) || !finite(point[1])) {
			throw new Error(`teeBadgeLock: teeLeg.path point ${index} must contain finite x,y.`);
		}
		return [point[0], point[1]] as const;
	});
}

function equalPath(a: TeeBadgePath, b: TeeBadgePath): boolean {
	return a.length === b.length && a.every((point, index) => samePoint(point, b[index]));
}

/**
 * Extract only the pathfinder testimony allowed by the feature contract.
 * Duplicate rows for one badge×tee pair are accepted only when every sampled
 * point is exactly identical; a divergent duplicate is a hard error.
 */
export function collapseTeeBadgePaths(rows: readonly TeeBadgePathInput[]): TeeBadgePathCandidate[] {
	const byPair = new Map<string, TeeBadgePathCandidate>();
	for (const row of rows) {
		// Keep these accesses intentionally explicit and local.  In particular,
		// do not destructure or inspect the rest of RawPairEvidence.
		const badgeId = row.badgeId;
		const teeId = row.teeId;
		const teeLeg = row.teeLeg;
		if (typeof badgeId !== 'string' || typeof teeId !== 'string' || !teeLeg) {
			throw new Error('teeBadgeLock: raw row must provide badgeId, teeId, and teeLeg.');
		}
		const legacyPath = clonePath(teeLeg.path);
		const candidate: TeeBadgePathCandidate = {
			badgeId,
			teeId,
			teeBadgePath: legacyPath.slice().reverse()
		};
		const key = `${badgeId}\u0000${teeId}`;
		const prior = byPair.get(key);
		if (prior) {
			if (!equalPath(prior.teeBadgePath, candidate.teeBadgePath)) {
				throw new Error(
					`teeBadgeLock: divergent duplicate teeBadgePath for badge '${badgeId}' and tee '${teeId}'.`
				);
			}
			continue;
		}
		byPair.set(key, candidate);
	}
	return [...byPair.values()].sort(
		(a, b) => compareText(a.badgeId, b.badgeId) || compareText(a.teeId, b.teeId)
	);
}

/** Public adapter alias required by the acceptance seam. */
export const extractTeeBadgePaths = collapseTeeBadgePaths;

function clamp(value: number, low: number, high: number): number {
	return Math.max(low, Math.min(high, value));
}

function cellFor(
	point: TeeBadgePoint,
	field: TeeBadgeLockSupportField,
	viewportTopPx: number
): readonly [number, number] {
	const x = clamp(Math.round(point[0] / field.scale), 0, Math.max(0, field.width - 1));
	const y = clamp(
		Math.round((point[1] - viewportTopPx) / field.scale),
		0,
		Math.max(0, field.height - 1)
	);
	return [x, y];
}

function fieldAt(values: ArrayLike<number>, index: number): number {
	const value = values[index];
	return finite(value) ? value : 0;
}

function tangentTheta(path: TeeBadgePath, index: number): number {
	if (path.length < 2) return 0;
	let previous = index - 1;
	while (previous >= 0 && samePoint(path[previous], path[index])) previous--;
	let next = index + 1;
	while (next < path.length && samePoint(path[next], path[index])) next++;
	if (previous < 0 && next >= path.length) return 0;
	const a = previous >= 0 ? path[previous] : path[index];
	const b = next < path.length ? path[next] : path[index];
	let dx = b[0] - a[0];
	let dy = b[1] - a[1];
	if (dx === 0 && dy === 0) {
		if (next < path.length) {
			dx = b[0] - path[Math.max(0, index - 1)][0];
			dy = b[1] - path[Math.max(0, index - 1)][1];
		} else if (previous >= 0) {
			dx = path[index][0] - a[0];
			dy = path[index][1] - a[1];
		}
	}
	return dx === 0 && dy === 0 ? 0 : Math.atan2(dy, dx);
}

function routeLength(path: TeeBadgePath): number {
	let length = 0;
	for (let index = 1; index < path.length; index++) {
		length += Math.hypot(path[index][0] - path[index - 1][0], path[index][1] - path[index - 1][1]);
	}
	return length;
}

function fallbackEndpoints(path: TeeBadgePath): {
	readonly tee: TeeBadgePoint;
	readonly badge: TeeBadgePoint;
} {
	return {
		tee: path[0] ?? [0, 0],
		badge: path[path.length - 1] ?? [0, 0]
	};
}

function axialAngleDelta(aRad: number, bRad: number): number {
	const period = Math.PI;
	const normalized = (value: number) => {
		const result = value % period;
		return result < 0 ? result + period : result;
	};
	const delta = normalized(aRad) - normalized(bRad);
	const wrapped = ((((delta + Math.PI / 2) % period) + period) % period) - Math.PI / 2;
	return Math.abs(wrapped);
}

function readPoint(value: unknown): TeeBadgePoint | undefined {
	if (Array.isArray(value) && finite(value[0]) && finite(value[1])) return [value[0], value[1]];
	if (value && typeof value === 'object') {
		const object = value as { xPx?: unknown; yPx?: unknown; cxPx?: unknown; cyPx?: unknown };
		const x = finite(object.xPx) ? object.xPx : object.cxPx;
		const y = finite(object.yPx) ? object.yPx : object.cyPx;
		if (finite(x) && finite(y)) return [x, y];
	}
	return undefined;
}

export interface ScoreTeeBadgePathInput {
	readonly candidate: TeeBadgePathCandidate;
	readonly field: TeeBadgeLockSupportField;
	readonly teeAxisRad?: number | null;
	readonly teeAxisSource?: TeeBadgeAxisSource;
	readonly teePoint?: TeeBadgePoint;
	readonly badgePoint?: TeeBadgePoint;
	readonly viewportTopPx?: number;
	readonly knobs: TeeBadgeLockMathKnobs;
}

/** Score one exact tee→badge testimony path. */
export function scoreTeeBadgePath(input: ScoreTeeBadgePathInput): TeeBadgeLockScoredCandidate {
	const { candidate, field, knobs } = input;
	if (!positiveFinite(field.scale)) throw new Error('teeBadgeLock: field.scale must be positive.');
	if (
		!Number.isInteger(field.width) ||
		field.width < 1 ||
		!Number.isInteger(field.height) ||
		field.height < 1
	) {
		throw new Error('teeBadgeLock: support field dimensions must be positive integers.');
	}
	if (!positiveFinite(knobs.teeOrientationSigmaDeg))
		throw new Error('teeBadgeLock: tee orientation sigma must be positive.');
	if (!finite(knobs.alignmentPower) || knobs.alignmentPower < 0)
		throw new Error('teeBadgeLock: alignmentPower must be finite and non-negative.');
	if (!finite(knobs.worstWindowSrcPx) || knobs.worstWindowSrcPx < 0)
		throw new Error('teeBadgeLock: worstWindowSrcPx must be finite and non-negative.');
	if (!Number.isInteger(knobs.minWindowCells) || knobs.minWindowCells < 1)
		throw new Error('teeBadgeLock: minWindowCells must be a positive integer.');
	const viewportTopPx = finite(input.viewportTopPx) ? input.viewportTopPx : 0;
	const path = candidate.teeBadgePath;
	const errors: number[] = [];
	for (let index = 0; index < path.length; index++) {
		const [cx, cy] = cellFor(path[index], field, viewportTopPx);
		const index1d = cy * field.width + cx;
		const support = fieldAt(field.support, index1d);
		const bestTheta = fieldAt(field.bestTheta, index1d);
		const alignment = Math.abs(Math.cos(tangentTheta(path, index) - bestTheta));
		errors.push(support * Math.pow(alignment, knobs.alignmentPower));
	}
	const windowCells = Math.max(
		knobs.minWindowCells,
		Math.round(knobs.worstWindowSrcPx / field.scale)
	);
	let weakAlignedSupport = 0;
	if (errors.length > 0) {
		if (errors.length <= windowCells) {
			weakAlignedSupport = errors.reduce((sum, value) => sum + value, 0) / errors.length;
		} else {
			weakAlignedSupport = Infinity;
			for (let start = 0; start + windowCells <= errors.length; start++) {
				let sum = 0;
				for (let offset = 0; offset < windowCells; offset++) sum += errors[start + offset];
				weakAlignedSupport = Math.min(weakAlignedSupport, sum / windowCells);
			}
		}
	}

	const fallback = fallbackEndpoints(path);
	const teePoint =
		input.teePoint ?? readPoint([candidate.teeXPx, candidate.teeYPx]) ?? fallback.tee;
	const badgePoint =
		input.badgePoint ?? readPoint([candidate.badgeXPx, candidate.badgeYPx]) ?? fallback.badge;
	const dx = badgePoint[0] - teePoint[0];
	const dy = badgePoint[1] - teePoint[1];
	const chordPx = Math.hypot(dx, dy);
	const routedLengthPx = routeLength(path);
	const pathEfficiency = chordPx === 0 ? 0 : chordPx / Math.max(chordPx, routedLengthPx);

	let axisSource: TeeBadgeAxisSource = input.teeAxisSource ?? UNKNOWN_AXIS;
	let axisErrorDeg: number | 'UNKNOWN' = 'UNKNOWN';
	let axisFactor = 1;
	if (finite(input.teeAxisRad) && chordPx > 0) {
		if (input.teeAxisSource === undefined) axisSource = 'TeeEvidence.angleRad';
		axisErrorDeg = (axialAngleDelta(input.teeAxisRad, Math.atan2(dy, dx)) * 180) / Math.PI;
		axisFactor = Math.exp(-((axisErrorDeg / knobs.teeOrientationSigmaDeg) ** 2));
	} else if (finite(input.teeAxisRad) && input.teeAxisSource === undefined) {
		axisSource = 'TeeEvidence.angleRad';
	}
	const score = weakAlignedSupport * pathEfficiency * axisFactor;
	return {
		...candidate,
		score,
		weakAlignedSupport,
		pathEfficiency,
		axisErrorDeg,
		axisFactor,
		axisSource,
		windowCells,
		routedLengthPx,
		chordPx,
		runnerUpMargin: null
	};
}

function axisFromTee(tee: unknown): {
	readonly rad: number | null;
	readonly source: TeeBadgeAxisSource;
} {
	if (!tee || typeof tee !== 'object') return { rad: null, source: UNKNOWN_AXIS };
	const value = tee as TeeBadgeTeeOrder;
	const minAreaPose = value.pad?.minAreaPose?.angleRad;
	if (finite(minAreaPose))
		return { rad: minAreaPose, source: 'TeeEvidence.pad.minAreaPose.angleRad' };
	if (finite(value.angleRad)) return { rad: value.angleRad, source: 'TeeEvidence.angleRad' };
	const padAngle = value.pad?.angleRad;
	if (finite(padAngle)) return { rad: padAngle, source: 'TeeEvidence.pad.angleRad' };
	return { rad: null, source: UNKNOWN_AXIS };
}

function pointFromEvidence(value: unknown): TeeBadgePoint | undefined {
	return readPoint(value);
}

export interface ScoreTeeBadgeCandidatesOptions {
	readonly candidates: readonly TeeBadgePathCandidate[];
	readonly field: TeeBadgeLockSupportField;
	readonly tees?: readonly TeeBadgeTeeOrder[];
	readonly badges?: readonly TeeBadgeBadgeOrder[];
	readonly viewportTopPx?: number;
	readonly knobs: TeeBadgeLockMathKnobs;
}

function normalizeCandidateScoringArgs(args: readonly unknown[]): ScoreTeeBadgeCandidatesOptions {
	if (
		args.length === 1 &&
		args[0] &&
		typeof args[0] === 'object' &&
		'candidates' in (args[0] as object)
	) {
		return args[0] as ScoreTeeBadgeCandidatesOptions;
	}
	const candidates = (args[0] ?? []) as readonly TeeBadgePathCandidate[];
	const field = args[1] as TeeBadgeLockSupportField;
	const tees = args[2] as readonly TeeBadgeTeeOrder[] | undefined;
	const badges = args[3] as readonly TeeBadgeBadgeOrder[] | undefined;
	const knobs = args[4] as TeeBadgeLockMathKnobs;
	const viewportTopPx = args[5] as number | undefined;
	return { candidates, field, tees, badges, knobs, viewportTopPx };
}

/** Score all collapsed candidates, enriching exact detector endpoint geometry
 * only where the caller supplied it.  Both object and positional forms are
 * accepted to keep this pure helper convenient for fixture-level callers. */
export function scoreTeeBadgeCandidates(...args: unknown[]): TeeBadgeLockScoredCandidate[] {
	const options = normalizeCandidateScoringArgs(args);
	const tees = new Map((options.tees ?? []).map((tee) => [tee.detId, tee]));
	const badges = new Map((options.badges ?? []).map((badge) => [badge.detId, badge]));
	return options.candidates.map((candidate) => {
		const tee = tees.get(candidate.teeId);
		const badge = badges.get(candidate.badgeId);
		const axis = axisFromTee(tee);
		return scoreTeeBadgePath({
			candidate,
			field: options.field,
			teeAxisRad: axis.rad,
			teeAxisSource: axis.source,
			teePoint: pointFromEvidence(tee) ?? readPoint([candidate.teeXPx, candidate.teeYPx]),
			badgePoint: pointFromEvidence(badge) ?? readPoint([candidate.badgeXPx, candidate.badgeYPx]),
			viewportTopPx: options.viewportTopPx,
			knobs: options.knobs
		});
	});
}

function exactPositiveHole(label: unknown): number | undefined {
	if (typeof label !== 'string' || !/^[1-9]\d*$/.test(label)) return undefined;
	const value = Number(label);
	return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function badgeSortValue(value: TeeBadgeBadgeOrder | undefined): readonly [number, number, string] {
	const hole = exactPositiveHole(value?.label);
	return [hole === undefined ? 1 : 0, hole ?? Number.MAX_SAFE_INTEGER, value?.detId ?? ''];
}

function compareBadges(a: TeeBadgeBadgeOrder, b: TeeBadgeBadgeOrder): number {
	const av = badgeSortValue(a);
	const bv = badgeSortValue(b);
	return av[0] - bv[0] || av[1] - bv[1] || av[2].localeCompare(bv[2]);
}

function compareText(a: string, b: string): number {
	return a === b ? 0 : a < b ? -1 : 1;
}

function candidateOrder(
	candidates: readonly TeeBadgeLockScoredCandidate[],
	badges?: readonly TeeBadgeBadgeOrder[],
	tees?: readonly TeeBadgeTeeOrder[]
): { readonly badgeIds: string[]; readonly teeIds: string[] } {
	const badgeMap = new Map((badges ?? []).map((badge) => [badge.detId, badge]));
	const teeMap = new Map((tees ?? []).map((tee) => [tee.detId, tee]));
	const badgeIds = [
		...new Set([
			...(badges ?? []).map((badge) => badge.detId),
			...candidates.map((candidate) => candidate.badgeId)
		])
	];
	const teeIds = [
		...new Set([
			...(tees ?? []).map((tee) => tee.detId),
			...candidates.map((candidate) => candidate.teeId)
		])
	];
	badgeIds.sort((a, b) => {
		const av = badgeMap.get(a);
		const bv = badgeMap.get(b);
		if (av && bv) return compareBadges(av, bv);
		if (av) return -1;
		if (bv) return 1;
		return compareText(a, b);
	});
	teeIds.sort((a, b) => compareText(a, b));
	return { badgeIds, teeIds };
}

/** Deterministic Hungarian maximization.  The matrix is padded with zero
 * dummy slots only when the two real dimensions differ; no dummy identifier
 * can escape in the result. */
function hungarianMaximum(weights: readonly (readonly number[])[]): readonly [number, number][] {
	const rows = weights.length;
	const cols = rows ? weights[0].length : 0;
	const size = Math.max(rows, cols);
	if (size === 0) return [];
	const cost = Array.from({ length: size + 1 }, (_, i) =>
		Array.from({ length: size + 1 }, (_, j) =>
			i === 0 || j === 0 ? 0 : -(weights[i - 1]?.[j - 1] ?? 0)
		)
	);
	const u = new Array<number>(size + 1).fill(0);
	const v = new Array<number>(size + 1).fill(0);
	const p = new Array<number>(size + 1).fill(0);
	const way = new Array<number>(size + 1).fill(0);
	for (let i = 1; i <= size; i++) {
		p[0] = i;
		let j0 = 0;
		const minv = new Array<number>(size + 1).fill(Infinity);
		const used = new Array<boolean>(size + 1).fill(false);
		do {
			used[j0] = true;
			const i0 = p[j0];
			let delta = Infinity;
			let j1 = 0;
			for (let j = 1; j <= size; j++) {
				if (used[j]) continue;
				const current = cost[i0][j] - u[i0] - v[j];
				if (current < minv[j]) {
					minv[j] = current;
					way[j] = j0;
				}
				if (minv[j] < delta || (Object.is(minv[j], delta) && j < j1)) {
					delta = minv[j];
					j1 = j;
				}
			}
			for (let j = 0; j <= size; j++) {
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
	const pairs: [number, number][] = [];
	for (let j = 1; j <= size; j++) {
		const row = p[j];
		if (row > 0 && row <= rows && j <= cols) pairs.push([row - 1, j - 1]);
	}
	return pairs;
}

/**
 * Exact maximum-weight one-to-one matching.  There is intentionally no score
 * threshold: zero and negative selected candidates remain observable.  A
 * candidate's runner-up is the best other real tee testimony for that badge,
 * whether or not that tee wins another badge.
 */
export function maximumWeightTeeBadgeMatching(
	candidates: readonly TeeBadgeLockScoredCandidate[],
	metadata: {
		readonly badges?: readonly TeeBadgeBadgeOrder[];
		readonly tees?: readonly TeeBadgeTeeOrder[];
	} = {}
): TeeBadgeLockResult {
	const { badgeIds, teeIds } = candidateOrder(candidates, metadata.badges, metadata.tees);
	const bestByPair = new Map<string, TeeBadgeLockScoredCandidate>();
	for (const candidate of candidates) {
		if (!finite(candidate.score)) throw new Error('teeBadgeLock: candidate scores must be finite.');
		const key = `${candidate.badgeId}\u0000${candidate.teeId}`;
		const prior = bestByPair.get(key);
		if (!prior || candidate.score > prior.score) bestByPair.set(key, candidate);
	}
	const sparseWeights = badgeIds.map((badgeId) =>
		teeIds.map((teeId) => bestByPair.get(`${badgeId}\u0000${teeId}`)?.score)
	);
	const maxAbsScore = [...bestByPair.values()].reduce(
		(maximum, candidate) => Math.max(maximum, Math.abs(candidate.score)),
		0
	);
	// Missing testimony is not a zero-score candidate. Penalize absent real
	// edges enough that the solver maximizes real-edge cardinality before
	// total score; rectangular padding inside Hungarian remains the only
	// source of structural dummy matches.
	const matrixSize = Math.max(badgeIds.length, teeIds.length);
	const missingEdgeWeight = -(2 * maxAbsScore * matrixSize + 1);
	const weights = sparseWeights.map((row) => row.map((score) => score ?? missingEdgeWeight));
	const assignments = hungarianMaximum(weights);
	const selectedByBadge = new Map<string, TeeBadgeLockScoredCandidate>();
	for (const [row, col] of assignments) {
		const badgeId = badgeIds[row];
		const teeId = teeIds[col];
		const candidate = bestByPair.get(`${badgeId}\u0000${teeId}`);
		if (candidate) selectedByBadge.set(badgeId, candidate);
	}
	const locks = badgeIds.flatMap((badgeId) => {
		const candidate = selectedByBadge.get(badgeId);
		if (!candidate) return [];
		const otherScores = candidates
			.filter((entry) => entry.badgeId === badgeId && entry.teeId !== candidate.teeId)
			.map((entry) => entry.score);
		const bestOther = otherScores.length ? Math.max(...otherScores) : undefined;
		const runnerUpMargin = bestOther === undefined ? null : candidate.score - bestOther;
		return [{ ...candidate, runnerUpMargin }];
	});
	const usedTees = new Set(locks.map((lock) => lock.teeId));
	const matchedBadges = new Set(locks.map((lock) => lock.badgeId));
	return {
		candidates: candidates.slice(),
		locks,
		unmatchedBadgeIds: badgeIds.filter((id) => !matchedBadges.has(id)),
		unusedTeeIds: teeIds.filter((id) => !usedTees.has(id))
	};
}

/** Public alias required by the acceptance seam. */
export const selectTeeBadgeLocks = maximumWeightTeeBadgeMatching;

function normalizedTier(tee: TeeBadgeTeeOrder | undefined): 'visible' | 'recovered' {
	return tee?.tier === 'recovered' ? 'recovered' : 'visible';
}

export interface BuildTeeBadgeLockEvidenceOptions {
	readonly badges?: readonly TeeBadgeBadgeOrder[];
	readonly tees?: readonly TeeBadgeTeeOrder[];
	readonly measurement?: {
		readonly parameters?: { readonly corridorWidthPx?: number };
	};
	readonly corridorWidthPx?: number;
}

/** Add the semantic, provenance-bearing envelope consumed by the operation
 * and by the LAB receipt.  Badge holes are copied only from exact labels. */
export function buildTeeBadgeLockEvidence(
	selected: TeeBadgeLockResult,
	options: BuildTeeBadgeLockEvidenceOptions = {}
): TeeBadgeLockEvidence {
	const badges = new Map((options.badges ?? []).map((badge) => [badge.detId, badge]));
	const tees = new Map((options.tees ?? []).map((tee) => [tee.detId, tee]));
	const locks = selected.locks.map((lock) => {
		const hole = exactPositiveHole(badges.get(lock.badgeId)?.label);
		return {
			...lock,
			tier: normalizedTier(tees.get(lock.teeId)),
			...(hole === undefined ? {} : { hole })
		};
	});
	// Evidence rows follow the same semantic badge order as matching whenever
	// BadgeEvidence is available.  This keeps numbered receipts naturally
	// readable even when an isolated caller matched by detector id only.
	locks.sort((a, b) => {
		const ah = a.hole ?? Number.MAX_SAFE_INTEGER;
		const bh = b.hole ?? Number.MAX_SAFE_INTEGER;
		return ah - bh || a.badgeId.localeCompare(b.badgeId);
	});
	const corridorWidthPx =
		options.corridorWidthPx ?? options.measurement?.parameters?.corridorWidthPx;
	return {
		...selected,
		locks,
		coordinateFrame: 'canonical-raster',
		basketEvidenceRead: false,
		corridorWidthPx: finite(corridorWidthPx) ? corridorWidthPx : 'UNKNOWN',
		corridorWidthPxProvenance: finite(corridorWidthPx)
			? 'measurement.parameters.corridorWidthPx'
			: 'UNKNOWN (measurement.parameters.corridorWidthPx)'
	};
}
