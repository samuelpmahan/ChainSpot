import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SourcePoint } from '../src/lib/domain/annotatedRound';

/**
 * TypeScript port of the hand-labeled bend-truth derivation in
 * `scripts/cv-probes/hole_path_semantic_bends.py`'s `truth()` function — the
 * same gutter files (`DB`/`DG`/`AL` in that script), the same arc-length
 * resample + two-segment-fit + weak-turn-pruning recipe, ported 1:1 so the
 * numbers this repo's TS benchmarks produce stay comparable to that probe's
 * committed 18/18-count / ~27px-median-location findings
 * (`scripts/cv-probes/hole-path-semantic-bends-findings.md`).
 *
 * Deliberately NOT ported: the probe's `contain`/`mask`/`SHAPE BAD` machinery.
 * That existed to sanity-check a *frozen, already-computed* centerline before
 * simplifying it further (the probe's whole subject was post-processing an
 * existing detector's output) — it has no equivalent when a detector traces
 * its own path from raw pixels, so every hole here is eligible for scoring,
 * matching the probe's own "raw" (unfiltered) aggregate numbers rather than
 * its shape-good-filtered ones.
 */

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '..');

const GOLDEN_GUTTERS_PATH = resolve(projectRoot, 'resources/ribbon-reference/IMG_5641-ribbon-golden.json');
const BENT_HOLES_PATH = resolve(projectRoot, 'resources/ribbon-reference/IMG_5641-bent-holes-labels.json');
const ALEX_LABELS_PATH = resolve(projectRoot, 'resources/stitch-annotate/AlexClark/AlexClark-McKinney-TX-labels.json');

/** `CATS` in the Python probe — cosmetic category labels for reporting only, no effect on scoring. */
const DASH_HOLE_CATEGORY: Readonly<Record<number, string>> = {
	1: 'gentle',
	2: 'gentle',
	3: 'straight',
	4: 'late bend',
	5: 'dogleg',
	6: 'straight',
	7: 'gentle',
	8: 'dogleg',
	9: 'straight',
	10: 'straight',
	11: 'straight',
	12: 'straight',
	13: 'straight',
	14: 'dogleg',
	15: 'gentle',
	16: 'straight',
	17: 'straight',
	18: 'two-bend'
};

export interface HoleBendTruth {
	readonly holeNumber: number;
	readonly truthCount: number;
	readonly truthBends: readonly SourcePoint[];
	readonly category: string;
	readonly source: string;
}

// ---------------------------------------------------------------------------
// Geometry primitives — direct ports of the probe's numpy one-liners.
// ---------------------------------------------------------------------------

function xy(point: { readonly xPx: number; readonly yPx: number }): SourcePoint {
	return { xPx: point.xPx, yPx: point.yPx };
}

function dist(a: SourcePoint, b: SourcePoint): number {
	return Math.hypot(a.xPx - b.xPx, a.yPx - b.yPx);
}

/** `orient(edge, tee)`: flips `edge` so its first point is the one closer to `tee`. */
function orient(edge: readonly SourcePoint[], tee: SourcePoint): SourcePoint[] {
	return dist(edge[0], tee) <= dist(edge[edge.length - 1], tee) ? edge.slice() : edge.slice().reverse();
}

/** `resample(edge, n)`: arc-length resampling of a polyline to exactly `n` evenly-spaced-by-length points. */
function resamplePolyline(points: readonly SourcePoint[], n: number): SourcePoint[] {
	const segmentLengths: number[] = [];
	for (let i = 1; i < points.length; i += 1) segmentLengths.push(dist(points[i - 1], points[i]));
	const cumulative = [0];
	for (const length of segmentLengths) cumulative.push(cumulative[cumulative.length - 1] + length);
	const total = cumulative[cumulative.length - 1];

	const out: SourcePoint[] = [];
	for (let k = 0; k < n; k += 1) {
		const s = n === 1 ? 0 : (total * k) / (n - 1);
		let segmentIndex = 0;
		while (segmentIndex < segmentLengths.length - 1 && cumulative[segmentIndex + 1] <= s) segmentIndex += 1;
		const segmentLength = Math.max(segmentLengths[segmentIndex] ?? 1e-12, 1e-12);
		const t = (s - cumulative[segmentIndex]) / segmentLength;
		const a = points[segmentIndex];
		const b = points[segmentIndex + 1] ?? a;
		out.push({ xPx: a.xPx + t * (b.xPx - a.xPx), yPx: a.yPx + t * (b.yPx - a.yPx) });
	}
	return out;
}

/** `sse(p, i, j)`: sum of squared distances of `points[i..j]` to the SEGMENT (not infinite line) from `points[i]` to `points[j]`. */
function segmentSse(points: readonly SourcePoint[], i: number, j: number): number {
	const a = points[i];
	const b = points[j];
	const vx = b.xPx - a.xPx;
	const vy = b.yPx - a.yPx;
	const denominator = vx * vx + vy * vy;
	let sum = 0;
	for (let k = i; k <= j; k += 1) {
		const q = points[k];
		let t = 0;
		if (denominator >= 1e-12) t = Math.min(1, Math.max(0, ((q.xPx - a.xPx) * vx + (q.yPx - a.yPx) * vy) / denominator));
		const projectedX = a.xPx + t * vx;
		const projectedY = a.yPx + t * vy;
		const dx = q.xPx - projectedX;
		const dy = q.yPx - projectedY;
		sum += dx * dx + dy * dy;
	}
	return sum;
}

/** `one_bend(center)`: the single split index minimizing the two-segment fit SSE, searched over the middle 60% of the resampled centerline. */
function oneBendIndex(center: readonly SourcePoint[]): number {
	const n = center.length;
	const lo = Math.max(2, Math.floor(0.2 * n));
	const hi = Math.min(n - 2, Math.floor(0.8 * n));
	let bestIndex = lo;
	let bestCost = Number.POSITIVE_INFINITY;
	for (let i = lo; i < hi; i += 1) {
		const cost = segmentSse(center, 0, i) + segmentSse(center, i, n - 1);
		if (cost < bestCost) {
			bestCost = cost;
			bestIndex = i;
		}
	}
	return bestIndex;
}

/** Unsigned turn magnitude at `b` (0 = straight through, 180 = full reversal) — same convention as `corridorBendDetection.ts`'s private `turnAngleDeg`, equivalent to the probe's `abs(wrap(headingOut - headingIn))`. */
function turnAngleDeg(a: SourcePoint, b: SourcePoint, c: SourcePoint): number {
	const v1x = b.xPx - a.xPx;
	const v1y = b.yPx - a.yPx;
	const v2x = c.xPx - b.xPx;
	const v2y = c.yPx - b.yPx;
	const len1 = Math.hypot(v1x, v1y);
	const len2 = Math.hypot(v2x, v2y);
	if (len1 === 0 || len2 === 0) return 0;
	const dot = (v1x * v2x + v1y * v2y) / (len1 * len2);
	return (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI;
}

/** `prune(poly)`: repeatedly deletes the FIRST interior point whose turn is weaker than 10 degrees, recomputing turns each time, until none remain. */
function pruneWeakBends(polyline: readonly SourcePoint[]): SourcePoint[] {
	const points = polyline.slice();
	for (;;) {
		if (points.length <= 2) break;
		let weakIndex = -1;
		for (let i = 1; i < points.length - 1; i += 1) {
			if (Math.abs(turnAngleDeg(points[i - 1], points[i], points[i + 1])) < 10) {
				weakIndex = i;
				break;
			}
		}
		if (weakIndex === -1) break;
		points.splice(weakIndex, 1);
	}
	return points;
}

/** Truth for a hole whose author-drawn gutters are anchored to an explicit tee/basket (`DB`/`AL` fixtures): midpoints of paired interior left/right edge points, pruned to significant turns. */
function bentHoleTruth(
	tee: SourcePoint,
	basket: SourcePoint,
	leftRaw: readonly SourcePoint[],
	rightRaw: readonly SourcePoint[]
): { readonly count: number; readonly bends: readonly SourcePoint[] } {
	const left = orient(leftRaw, tee);
	const right = orient(rightRaw, tee);
	const mids: SourcePoint[] = [];
	for (let i = 1; i < left.length - 1 && i < right.length - 1; i += 1) {
		mids.push({ xPx: (left[i].xPx + right[i].xPx) / 2, yPx: (left[i].yPx + right[i].yPx) / 2 });
	}
	const pruned = pruneWeakBends([tee, ...mids, basket]);
	return { count: pruned.length - 2, bends: pruned.slice(1, -1) };
}

/** Truth for a hole from the dense golden-gutter fixture (`DG`, no explicit tee/basket): the resampled left/right centerline's midpoint, with at most one bend at the best two-segment split. */
function goldenGutterTruth(
	leftEdge: readonly SourcePoint[],
	rightEdgeRaw: readonly SourcePoint[],
	includeBend: boolean
): { readonly count: number; readonly bends: readonly SourcePoint[] } {
	let rightEdge = rightEdgeRaw;
	const l0 = leftEdge[0];
	const lEnd = leftEdge[leftEdge.length - 1];
	const r0 = rightEdgeRaw[0];
	const rEnd = rightEdgeRaw[rightEdgeRaw.length - 1];
	if (dist(l0, r0) + dist(lEnd, rEnd) > dist(l0, rEnd) + dist(lEnd, r0)) rightEdge = rightEdgeRaw.slice().reverse();

	const leftResampled = resamplePolyline(leftEdge, 101);
	const rightResampled = resamplePolyline(rightEdge, 101);
	const center = leftResampled.map((point, index) => ({
		xPx: (point.xPx + rightResampled[index].xPx) / 2,
		yPx: (point.yPx + rightResampled[index].yPx) / 2
	}));
	if (!includeBend) return { count: 0, bends: [] };
	return { count: 1, bends: [center[oneBendIndex(center)]] };
}

// ---------------------------------------------------------------------------
// Fixture loaders
// ---------------------------------------------------------------------------

export interface GoldenGutterFile {
	readonly holes: readonly { readonly number: number; readonly leftEdge: readonly SourcePoint[]; readonly rightEdge: readonly SourcePoint[] }[];
}

export interface BentHolesFile {
	readonly holes: readonly {
		readonly number: number;
		readonly tee: SourcePoint;
		readonly basket: SourcePoint;
		readonly left: readonly SourcePoint[];
		readonly right: readonly SourcePoint[];
	}[];
}

/** Also the tee/basket source fed to both detectors for AlexClark holes (see the benchmark script) — the same fixture the truth bends derive from, so there's no separate/inconsistent anchor. */
export function loadAlexClarkFixture(): BentHolesFile {
	return JSON.parse(readFileSync(ALEX_LABELS_PATH, 'utf8')) as BentHolesFile;
}

/** Ports `truth()`'s Dash branch: holes 1-3 from the dense golden-gutter fixture, holes 4-18 from the explicit bent-holes fixture (unlisted = straight, per that file's own `note` field). */
export function buildDashGroundTruth(): HoleBendTruth[] {
	const golden = JSON.parse(readFileSync(GOLDEN_GUTTERS_PATH, 'utf8')) as GoldenGutterFile;
	const bent = JSON.parse(readFileSync(BENT_HOLES_PATH, 'utf8')) as BentHolesFile;

	const results = new Map<number, HoleBendTruth>();
	for (const hole of golden.holes) {
		const number = Number(hole.number);
		const { count, bends } = goldenGutterTruth(hole.leftEdge.map(xy), hole.rightEdge.map(xy), number === 1 || number === 2);
		results.set(number, { holeNumber: number, truthCount: count, truthBends: bends, category: DASH_HOLE_CATEGORY[number], source: 'dense golden gutters' });
	}

	const bentByNumber = new Map(bent.holes.map((hole) => [Number(hole.number), hole]));
	for (let number = 4; number <= 18; number += 1) {
		const hole = bentByNumber.get(number);
		if (!hole) {
			results.set(number, { holeNumber: number, truthCount: 0, truthBends: [], category: DASH_HOLE_CATEGORY[number], source: 'bent fixture unlisted=straight' });
			continue;
		}
		const { count, bends } = bentHoleTruth(xy(hole.tee), xy(hole.basket), hole.left.map(xy), hole.right.map(xy));
		results.set(number, { holeNumber: number, truthCount: count, truthBends: bends, category: DASH_HOLE_CATEGORY[number], source: 'explicit bent gutters' });
	}
	return [...results.values()].sort((a, b) => a.holeNumber - b.holeNumber);
}

/** Ports `truth()`'s AlexClark branch: all 3 holes in the fixture are explicit bent-gutter labels, exactly like Dash holes 4-18. No straight-hole labels exist for this course (see the findings doc: "a straight-hole false-positive rate cannot honestly be measured from the current Alex fixture"). */
export function buildAlexClarkGroundTruth(): HoleBendTruth[] {
	const fixture = loadAlexClarkFixture();
	return fixture.holes.map((hole) => {
		const { count, bends } = bentHoleTruth(xy(hole.tee), xy(hole.basket), hole.left.map(xy), hole.right.map(xy));
		return { holeNumber: Number(hole.number), truthCount: count, truthBends: bends, category: 'bent', source: 'existing Alex bent gutters' };
	});
}
