// Walk-trace extraction for a UDisc thrown-round screenshot.
//
// New capability: the old app annotated the walking path by hand
// (old-stuff/src/lib/walkingPath.ts is manual reducers only), so there is no
// prior algorithm to port — only the measured fact that UDisc renders the
// walk as one open purple polyline (purpleMass.ts measured its dominant hue
// at 255–260°).
//
// Approach: mask walk purple → coarse occupancy grid → largest 8-connected
// cell mass → path endpoints via double BFS (graph diameter) → BFS path →
// Douglas–Peucker simplification. Emits ordered 'walk-vertex' objects in
// original-image pixels. Pure TS, no OpenCV, no DOM.
//
// Known limits (accepted for MVP): a self-crossing walk collapses to the
// diameter path through the crossing, and forks (out-and-back spurs) are
// dropped — the user reviews/edits the trace on Map Round.

import type { Detector, RgbaRaster } from '../detect';
import { rgbToHsv } from './hsv';

export const WALK_TRACE_ALGO = 'walk-trace-grid';
export const WALK_TRACE_ALGO_VERSION = '1.0.0';

// Same family purpleMass gates on (its window: 245–275°, s/v ≥ 0.35).
const HUE_MIN_DEG = 245;
const HUE_MAX_DEG = 275;
const SATURATION_MIN = 0.35;
const VALUE_MIN = 0.35;

// Grid cell edge in px: coarse enough to bridge the dashed/antialiased line,
// fine enough that corners survive. ~1/200 of the smaller image dimension.
const CELL_DIVISOR = 200;
const CELL_MIN_PX = 3;

// Cells with fewer purple pixels than this fraction of the cell are noise.
const CELL_FILL_MIN = 0.04;

// Simplification tolerance, in cells.
const SIMPLIFY_TOLERANCE_CELLS = 1.5;

// A walk is LONG: its endpoint-to-endpoint path must span at least this many
// cells. Compact purple blobs (logos, buttons, specks) fail this even when
// they clear the mass gate.
const MIN_PATH_DIAMETER_CELLS = 10;

export interface WalkVertex {
	readonly xPx: number;
	readonly yPx: number;
}

function isWalkPurple(r: number, g: number, b: number): boolean {
	const { h, s, v } = rgbToHsv(r, g, b);
	return h >= HUE_MIN_DEG && h <= HUE_MAX_DEG && s >= SATURATION_MIN && v >= VALUE_MIN;
}

/** Douglas–Peucker on an ordered open polyline. */
export function simplifyPath(points: readonly WalkVertex[], tolerancePx: number): WalkVertex[] {
	if (points.length <= 2) return points.slice();
	const keep = new Uint8Array(points.length);
	keep[0] = 1;
	keep[points.length - 1] = 1;
	const stack: [number, number][] = [[0, points.length - 1]];
	while (stack.length > 0) {
		const [a, b] = stack.pop() as [number, number];
		const ax = points[a].xPx;
		const ay = points[a].yPx;
		const dx = points[b].xPx - ax;
		const dy = points[b].yPx - ay;
		const len = Math.hypot(dx, dy);
		let worst = -1;
		let worstDist = tolerancePx;
		for (let i = a + 1; i < b; i++) {
			const px = points[i].xPx - ax;
			const py = points[i].yPx - ay;
			const dist = len === 0 ? Math.hypot(px, py) : Math.abs(px * dy - py * dx) / len;
			if (dist > worstDist) {
				worstDist = dist;
				worst = i;
			}
		}
		if (worst >= 0) {
			keep[worst] = 1;
			stack.push([a, worst], [worst, b]);
		}
	}
	return points.filter((_, i) => keep[i] === 1);
}

/**
 * Pure core: extract the ordered walk polyline, or [] when no plausible
 * walk mass exists (e.g. this image is not a thrown round).
 */
export function traceWalk(image: RgbaRaster): WalkVertex[] {
	const { widthPx: w, heightPx: h, rgba } = image;
	if (w <= 0 || h <= 0) throw new Error('Walk-trace image dimensions must be positive.');
	if (rgba.length !== w * h * 4)
		throw new Error('Walk-trace RGBA byte length does not match image dimensions.');

	const cellPx = Math.max(CELL_MIN_PX, Math.floor(Math.min(w, h) / CELL_DIVISOR));
	const gw = Math.ceil(w / cellPx);
	const gh = Math.ceil(h / cellPx);

	// Occupancy grid: purple pixel count and centroid per cell.
	const count = new Uint32Array(gw * gh);
	const sumX = new Float64Array(gw * gh);
	const sumY = new Float64Array(gw * gh);
	for (let y = 0; y < h; y++) {
		const gy = Math.floor(y / cellPx);
		for (let x = 0; x < w; x++) {
			const p = (y * w + x) * 4;
			if (!isWalkPurple(rgba[p], rgba[p + 1], rgba[p + 2])) continue;
			const c = gy * gw + Math.floor(x / cellPx);
			count[c]++;
			sumX[c] += x;
			sumY[c] += y;
		}
	}
	const fillMin = Math.max(1, Math.floor(cellPx * cellPx * CELL_FILL_MIN));
	const occupied = new Uint8Array(gw * gh);
	for (let c = 0; c < occupied.length; c++) if (count[c] >= fillMin) occupied[c] = 1;

	// Largest 8-connected component of occupied cells.
	const comp = new Int32Array(gw * gh).fill(-1);
	let bestComp = -1;
	let bestSize = 0;
	let nComp = 0;
	const stack: number[] = [];
	for (let start = 0; start < occupied.length; start++) {
		if (occupied[start] !== 1 || comp[start] !== -1) continue;
		const id = nComp++;
		let size = 0;
		stack.push(start);
		comp[start] = id;
		while (stack.length > 0) {
			const c = stack.pop() as number;
			size++;
			const cx = c % gw;
			const cy = (c - cx) / gw;
			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					if (dx === 0 && dy === 0) continue;
					const nx = cx + dx;
					const ny = cy + dy;
					if (nx < 0 || nx >= gw || ny < 0 || ny >= gh) continue;
					const n = ny * gw + nx;
					if (occupied[n] === 1 && comp[n] === -1) {
						comp[n] = id;
						stack.push(n);
					}
				}
			}
		}
		if (size > bestSize) {
			bestSize = size;
			bestComp = id;
		}
	}
	// A real walk spans many cells; a couple of purple specks are not a walk.
	if (bestComp < 0 || bestSize < 4) return [];

	// BFS from an arbitrary component cell to the farthest cell (a), then from
	// a to the farthest cell (b): a→b is the path diameter — the walk's ends.
	const inComp = (c: number) => comp[c] === bestComp;
	let anyCell = -1;
	for (let c = 0; c < comp.length; c++)
		if (inComp(c)) {
			anyCell = c;
			break;
		}

	const bfs = (from: number): { dist: Int32Array; far: number; prev: Int32Array } => {
		const dist = new Int32Array(gw * gh).fill(-1);
		const prev = new Int32Array(gw * gh).fill(-1);
		const queue: number[] = [from];
		dist[from] = 0;
		let far = from;
		for (let qi = 0; qi < queue.length; qi++) {
			const c = queue[qi];
			if (dist[c] > dist[far]) far = c;
			const cx = c % gw;
			const cy = (c - cx) / gw;
			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					if (dx === 0 && dy === 0) continue;
					const nx = cx + dx;
					const ny = cy + dy;
					if (nx < 0 || nx >= gw || ny < 0 || ny >= gh) continue;
					const n = ny * gw + nx;
					if (inComp(n) && dist[n] === -1) {
						dist[n] = dist[c] + 1;
						prev[n] = c;
						queue.push(n);
					}
				}
			}
		}
		return { dist, far, prev };
	};

	const first = bfs(anyCell);
	const second = bfs(first.far);
	if (second.dist[second.far] < MIN_PATH_DIAMETER_CELLS) return [];

	// Walk back b → a along BFS predecessors, then reverse to get a → b.
	const cellPath: number[] = [];
	for (let c = second.far; c !== -1; c = second.prev[c]) cellPath.push(c);
	cellPath.reverse();

	const raw: WalkVertex[] = cellPath.map((c) => ({
		xPx: sumX[c] / count[c],
		yPx: sumY[c] / count[c]
	}));
	const simplified = simplifyPath(raw, SIMPLIFY_TOLERANCE_CELLS * cellPx);
	return simplified.map((v) => ({ xPx: Math.round(v.xPx), yPx: Math.round(v.yPx) }));
}

export const walkTraceDetector: Detector = async (image, emit) => {
	const vertices = traceWalk(image);
	for (let i = 0; i < vertices.length; i++) {
		emit({
			kind: 'object',
			detId: `walk-vertex-${i}`,
			objType: 'walk-vertex',
			xPx: vertices[i].xPx,
			yPx: vertices[i].yPx,
			seq: i,
			// Mass + diameter heuristics, not a calibrated model.
			confidence: 0.7,
			imageId: image.imageId,
			algo: WALK_TRACE_ALGO,
			algoVersion: WALK_TRACE_ALGO_VERSION
		});
	}
};
