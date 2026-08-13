/**
 * Preliminary automatic corridor-bend detector — fires once a hole's tee and
 * basket are both confirmed (see `approveHolePieces` in the Annotate Round
 * page), and proposes zero or more bend points along the fairway between
 * them. Proposals are added through the existing `addCorridorBend` primitive
 * as plain `SourcePoint`s, exactly like a hand-placed bend — nothing here
 * ever attaches a confidence/provenance field (see `annotatedRound.ts`'s
 * provenance rule).
 *
 * Substrate: NOT the whole-course ribbon-mass segmentation
 * (`ribbonMass.ts`/`ribbonMassShadow*.ts`). That pipeline's own module docs
 * declare it must never gate a production decision ("it never outputs a tee,
 * never arbitrates shared components, and never gates any production
 * decision" / "must not change authoritative AnnotatedHole geometry ... or
 * gate any production decision") — adding real `corridorBends` from it would
 * break that documented invariant, and it is tuned for whole-course
 * badge/basket ownership, not per-hole fairway tracing. Instead this module
 * runs a small, self-contained, per-hole heuristic: crop a local region
 * around the hole's own tee/basket, classify pixels by color similarity to
 * swatches sampled next to tee and basket themselves (self-calibrating per
 * hole/course, not a fixed cross-course color threshold), trace the shortest
 * path through the "open" pixels between tee and basket, and simplify that
 * path with Ramer-Douglas-Peucker (RDP) — the same simplification the
 * `hole_path_semantic_bends` research probe validated (18/18 and 3/3 correct
 * bend counts, zero false bends on 9 straight holes) against a different,
 * paused substrate (`centerlineDetection.ts`). RDP itself is substrate-
 * independent; only the "what path do we simplify" step changed here.
 *
 * Conservative by construction: a poor/noisy color classification tends to
 * leave a generous "open" region around the true corridor, and the shortest
 * path through a generous open region is close to a straight line — RDP
 * then collapses it to zero interior points. A false bend instead requires
 * the classifier to block the direct line while leaving a genuine detour
 * open, which is a comparatively narrow failure mode. Additional guards
 * (`maxDetourRatio`, `minTurnAngleDeg`) bias further toward proposing
 * nothing over proposing something wrong, matching this feature's brief: a
 * good-enough starting point for a fully draggable/deletable marker, not a
 * final answer.
 *
 * This has NOT been validated against any labeled course (no ground-truth
 * fixture for raw pixel-color bend tracing exists in this repo) — treat it
 * as a first-pass heuristic, not a tuned detector.
 */
import type { AnnotatedHole, SourcePoint } from '../domain/annotatedRound';
import { addCorridorBend } from '../holeAnnotation';

// ---------------------------------------------------------------------------
// RDP polyline simplification — pure geometry, no raster dependency.
// ---------------------------------------------------------------------------

/**
 * Ramer-Douglas-Peucker simplification: keeps the endpoints and any interior
 * point more than `epsilonPx` from the line connecting its surviving
 * neighbors, dropping the rest. A straight (or near-straight) input collapses
 * to just its two endpoints.
 */
export function simplifyPolylineRDP(points: readonly SourcePoint[], epsilonPx: number): SourcePoint[] {
	if (points.length <= 2) return points.slice();
	const keep = new Uint8Array(points.length);
	keep[0] = 1;
	keep[points.length - 1] = 1;
	const stack: [number, number][] = [[0, points.length - 1]];
	while (stack.length > 0) {
		const [start, end] = stack.pop()!;
		if (end <= start + 1) continue;
		let maxDist = -1;
		let maxIndex = -1;
		for (let i = start + 1; i < end; i += 1) {
			const dist = perpendicularDistance(points[i], points[start], points[end]);
			if (dist > maxDist) {
				maxDist = dist;
				maxIndex = i;
			}
		}
		if (maxDist > epsilonPx) {
			keep[maxIndex] = 1;
			stack.push([start, maxIndex]);
			stack.push([maxIndex, end]);
		}
	}
	return points.filter((_, index) => keep[index] === 1);
}

function perpendicularDistance(point: SourcePoint, lineStart: SourcePoint, lineEnd: SourcePoint): number {
	const dx = lineEnd.xPx - lineStart.xPx;
	const dy = lineEnd.yPx - lineStart.yPx;
	const lengthSq = dx * dx + dy * dy;
	if (lengthSq === 0) return Math.hypot(point.xPx - lineStart.xPx, point.yPx - lineStart.yPx);
	const t = ((point.xPx - lineStart.xPx) * dx + (point.yPx - lineStart.yPx) * dy) / lengthSq;
	const projX = lineStart.xPx + t * dx;
	const projY = lineStart.yPx + t * dy;
	return Math.hypot(point.xPx - projX, point.yPx - projY);
}

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

/** Drops any interior (non-endpoint) point whose turn is gentler than `minTurnAngleDeg` — a second, independent conservatism pass on top of RDP's own epsilon. */
function filterByTurnAngle(simplified: readonly SourcePoint[], minTurnAngleDeg: number): SourcePoint[] {
	const interior = simplified.slice(1, -1);
	const kept: SourcePoint[] = [];
	for (let i = 0; i < interior.length; i += 1) {
		const prev = i === 0 ? simplified[0] : interior[i - 1];
		const current = interior[i];
		const next = i === interior.length - 1 ? simplified[simplified.length - 1] : interior[i + 1];
		if (turnAngleDeg(prev, current, next) >= minTurnAngleDeg) kept.push(current);
	}
	return kept;
}

function polylineLength(points: readonly SourcePoint[]): number {
	let total = 0;
	for (let i = 1; i < points.length; i += 1) {
		total += Math.hypot(points[i].xPx - points[i - 1].xPx, points[i].yPx - points[i - 1].yPx);
	}
	return total;
}

// ---------------------------------------------------------------------------
// Local raster substrate — a small crop around one hole's tee/basket.
// ---------------------------------------------------------------------------

/** A small RGB(A) crop around one hole, plus enough to map its pixels back to source-image space. */
export interface CorridorBendRaster {
	readonly widthPx: number;
	readonly heightPx: number;
	/** Top-left corner of this crop, in source-image pixels. */
	readonly originXPx: number;
	readonly originYPx: number;
	/** Source pixels per raster pixel (1 = no downscale). */
	readonly scale: number;
	/** RGB(A) bytes, row-major. */
	readonly data: Uint8Array | Uint8ClampedArray;
	readonly channels: 3 | 4;
}

function toLocal(raster: CorridorBendRaster, point: SourcePoint): SourcePoint {
	return {
		xPx: (point.xPx - raster.originXPx) / raster.scale,
		yPx: (point.yPx - raster.originYPx) / raster.scale
	};
}

function inBounds(raster: CorridorBendRaster, point: SourcePoint): boolean {
	return point.xPx >= 0 && point.xPx < raster.widthPx && point.yPx >= 0 && point.yPx < raster.heightPx;
}

function sampleColor(raster: CorridorBendRaster, xPx: number, yPx: number): readonly [number, number, number] {
	const xi = Math.min(raster.widthPx - 1, Math.max(0, Math.round(xPx)));
	const yi = Math.min(raster.heightPx - 1, Math.max(0, Math.round(yPx)));
	const p = (yi * raster.widthPx + xi) * raster.channels;
	return [raster.data[p], raster.data[p + 1], raster.data[p + 2]];
}

function medianColor(samples: readonly (readonly [number, number, number])[]): readonly [number, number, number] {
	const channel = (index: number) => samples.map((sample) => sample[index]).sort((a, b) => a - b);
	const mid = Math.floor(samples.length / 2);
	const r = channel(0);
	const g = channel(1);
	const b = channel(2);
	return [r[mid], g[mid], b[mid]];
}

/** Ring-samples color around tee and basket (never AT them — a tee pad and a basket marker icon are not fairway-colored) to build a per-hole, self-calibrating fairway reference. */
function sampleReferenceColors(
	raster: CorridorBendRaster,
	teeLocal: SourcePoint,
	basketLocal: SourcePoint,
	radiusLocalPx: number
): (readonly [number, number, number])[] {
	const colors: (readonly [number, number, number])[] = [];
	for (const center of [teeLocal, basketLocal]) {
		const samples: (readonly [number, number, number])[] = [];
		for (let i = 0; i < 8; i += 1) {
			const angle = (i / 8) * Math.PI * 2;
			const xPx = center.xPx + Math.cos(angle) * radiusLocalPx;
			const yPx = center.yPx + Math.sin(angle) * radiusLocalPx;
			if (xPx < 0 || xPx >= raster.widthPx || yPx < 0 || yPx >= raster.heightPx) continue;
			samples.push(sampleColor(raster, xPx, yPx));
		}
		if (samples.length > 0) colors.push(medianColor(samples));
	}
	return colors;
}

/** Binary mask: 1 where a pixel's color is within `toleranceRgb` (Euclidean RGB distance) of any reference color. */
export function buildTraversabilityMask(
	raster: CorridorBendRaster,
	referenceColors: readonly (readonly [number, number, number])[],
	toleranceRgb: number
): Uint8Array {
	const open = new Uint8Array(raster.widthPx * raster.heightPx);
	for (let y = 0; y < raster.heightPx; y += 1) {
		for (let x = 0; x < raster.widthPx; x += 1) {
			const p = (y * raster.widthPx + x) * raster.channels;
			const r = raster.data[p];
			const g = raster.data[p + 1];
			const b = raster.data[p + 2];
			let matches = false;
			for (const ref of referenceColors) {
				const dr = r - ref[0];
				const dg = g - ref[1];
				const db = b - ref[2];
				if (Math.sqrt(dr * dr + dg * dg + db * db) <= toleranceRgb) {
					matches = true;
					break;
				}
			}
			open[y * raster.widthPx + x] = matches ? 1 : 0;
		}
	}
	return open;
}

function nearestOpenCell(
	open: Uint8Array,
	width: number,
	height: number,
	point: SourcePoint,
	searchRadiusPx: number
): SourcePoint | null {
	const xi0 = Math.round(point.xPx);
	const yi0 = Math.round(point.yPx);
	const xi = Math.min(width - 1, Math.max(0, xi0));
	const yi = Math.min(height - 1, Math.max(0, yi0));
	if (xi < 0 || yi < 0 || xi >= width || yi >= height) return null;
	if (open[yi * width + xi] === 1) return { xPx: xi, yPx: yi };
	const r = Math.max(1, Math.round(searchRadiusPx));
	const x0 = Math.max(0, xi - r);
	const x1 = Math.min(width - 1, xi + r);
	const y0 = Math.max(0, yi - r);
	const y1 = Math.min(height - 1, yi + r);
	let best: SourcePoint | null = null;
	let bestDistSq = Infinity;
	for (let y = y0; y <= y1; y += 1) {
		for (let x = x0; x <= x1; x += 1) {
			if (open[y * width + x] !== 1) continue;
			const dx = x - xi0;
			const dy = y - yi0;
			const distSq = dx * dx + dy * dy;
			if (distSq < bestDistSq) {
				bestDistSq = distSq;
				best = { xPx: x, yPx: y };
			}
		}
	}
	return best;
}

/** Integer edge weights approximating Euclidean step cost (7/5 = 1.4 ~= sqrt(2)). */
const ORTHOGONAL_WEIGHT = 5;
const DIAGONAL_WEIGHT = 7;

/**
 * Shortest 8-connected path through `open` cells from `fromPx` to `toPx`
 * (each snapped to the nearest open cell within `searchRadiusPx` first, since
 * a tee pad / basket marker icon rarely classifies as "open" itself).
 * Weighted Dijkstra (via a Dial's-algorithm bucket queue — edge weights only
 * take two small integer values, so this needs no binary heap), NOT plain
 * unweighted BFS: an unweighted 8-connected shortest path treats a diagonal
 * step as free, so a path that bulges far off the direct line while still
 * making net progress is just as "shortest" (in step count) as the direct
 * line itself — the exact false-bend risk this detector must avoid on a
 * straight, diagonally-oriented hole. Weighting diagonal steps above
 * orthogonal ones removes that degeneracy. Returns null when no path exists.
 */
export function traceShortestOpenPath(
	open: Uint8Array,
	width: number,
	height: number,
	fromPx: SourcePoint,
	toPx: SourcePoint,
	searchRadiusPx: number = 20
): SourcePoint[] | null {
	const start = nearestOpenCell(open, width, height, fromPx, searchRadiusPx);
	const end = nearestOpenCell(open, width, height, toPx, searchRadiusPx);
	if (!start || !end) return null;
	const startIdx = start.yPx * width + start.xPx;
	const endIdx = end.yPx * width + end.xPx;
	if (startIdx === endIdx) return [start, end];

	const n = width * height;
	const dist = new Int32Array(n).fill(-1);
	const prev = new Int32Array(n).fill(-1);
	dist[startIdx] = 0;

	const dirs: readonly (readonly [number, number, number])[] = [
		[-1, -1, DIAGONAL_WEIGHT], [0, -1, ORTHOGONAL_WEIGHT], [1, -1, DIAGONAL_WEIGHT],
		[-1, 0, ORTHOGONAL_WEIGHT], [1, 0, ORTHOGONAL_WEIGHT],
		[-1, 1, DIAGONAL_WEIGHT], [0, 1, ORTHOGONAL_WEIGHT], [1, 1, DIAGONAL_WEIGHT]
	];

	const maxBucket = (width + height) * DIAGONAL_WEIGHT + 1;
	const buckets: number[][] = Array.from({ length: maxBucket + 1 }, () => []);
	buckets[0].push(startIdx);
	let finalized = false;

	for (let d = 0; d <= maxBucket && !finalized; d += 1) {
		const bucket = buckets[d];
		for (let bi = 0; bi < bucket.length; bi += 1) {
			const idx = bucket[bi];
			if (dist[idx] !== d) continue; // superseded by an earlier, better relaxation
			if (idx === endIdx) {
				finalized = true;
				break;
			}
			const x = idx % width;
			const y = (idx - x) / width;
			for (const [dx, dy, weight] of dirs) {
				const nx = x + dx;
				const ny = y + dy;
				if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
				const nIdx = ny * width + nx;
				if (open[nIdx] === 0) continue;
				const nd = d + weight;
				// A fragmented/maze-like open region (plausible from noisy real-world
				// color classification) can force a path far longer than any straight
				// or near-straight route, exceeding `buckets`' (width+height)-based
				// bound -- reject rather than index past its end. Harmless:
				// `maxDetourRatio` would reject a path this long anyway, so bounding
				// the search here changes no real outcome.
				if (nd > maxBucket) continue;
				if (dist[nIdx] === -1 || nd < dist[nIdx]) {
					dist[nIdx] = nd;
					prev[nIdx] = idx;
					buckets[nd].push(nIdx);
				}
			}
		}
	}
	if (dist[endIdx] === -1) return null;

	const path: SourcePoint[] = [];
	let cursor = endIdx;
	// eslint-disable-next-line no-constant-condition
	while (true) {
		const x = cursor % width;
		const y = (cursor - x) / width;
		path.push({ xPx: x, yPx: y });
		if (cursor === startIdx) break;
		cursor = prev[cursor];
	}
	path.reverse();
	return path;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface DetectCorridorBendsParams {
	/** Euclidean RGB distance a pixel must be within some reference color to count as "open". */
	readonly colorTolerance: number;
	/** RDP epsilon, in SOURCE-image pixels (the probe's validated ~10px). */
	readonly rdpEpsilonPx: number;
	/** Minimum turn angle (degrees) an interior point must have to survive as a proposed bend. */
	readonly minTurnAngleDeg: number;
	/** Reject the traced path entirely if its length exceeds this multiple of the straight tee-basket distance — a sign the classification broke down, not a real dogleg. */
	readonly maxDetourRatio: number;
	/** Hard cap on proposed bends per hole. */
	readonly maxBends: number;
	/** Radius (source px) of the color-reference ring sampled around tee and basket. */
	readonly referenceSampleRadiusPx: number;
}

export const DEFAULT_CORRIDOR_BEND_PARAMS: DetectCorridorBendsParams = {
	colorTolerance: 42,
	rdpEpsilonPx: 10,
	minTurnAngleDeg: 12,
	maxDetourRatio: 1.6,
	maxBends: 3,
	referenceSampleRadiusPx: 24
};

/**
 * Proposes zero or more corridor bend points between `teeSrcPx` and
 * `basketSrcPx`, in source-image pixels, ordered tee-to-basket. Pure: takes
 * an already-extracted raster rather than touching the DOM/canvas, so it is
 * directly unit-testable with synthetic crops.
 */
export function detectCorridorBends(
	raster: CorridorBendRaster,
	teeSrcPx: SourcePoint,
	basketSrcPx: SourcePoint,
	params: DetectCorridorBendsParams = DEFAULT_CORRIDOR_BEND_PARAMS
): SourcePoint[] {
	const teeLocal = toLocal(raster, teeSrcPx);
	const basketLocal = toLocal(raster, basketSrcPx);
	if (!inBounds(raster, teeLocal) || !inBounds(raster, basketLocal)) return [];

	const referenceColors = sampleReferenceColors(
		raster,
		teeLocal,
		basketLocal,
		params.referenceSampleRadiusPx / raster.scale
	);
	if (referenceColors.length === 0) return [];

	const open = buildTraversabilityMask(raster, referenceColors, params.colorTolerance);
	const searchRadiusLocalPx = Math.max(4, Math.round(20 / raster.scale));
	const path = traceShortestOpenPath(open, raster.widthPx, raster.heightPx, teeLocal, basketLocal, searchRadiusLocalPx);
	if (!path || path.length < 2) return [];

	const straightDistance = Math.hypot(basketLocal.xPx - teeLocal.xPx, basketLocal.yPx - teeLocal.yPx);
	if (straightDistance <= 0) return [];
	const detourRatio = polylineLength(path) / straightDistance;
	if (detourRatio > params.maxDetourRatio) return [];

	const simplified = simplifyPolylineRDP(path, params.rdpEpsilonPx / raster.scale);
	if (simplified.length <= 2) return [];

	const bends = filterByTurnAngle(simplified, params.minTurnAngleDeg).slice(0, params.maxBends);
	if (bends.length === 0) return [];

	return bends.map((point) => ({
		xPx: point.xPx * raster.scale + raster.originXPx,
		yPx: point.yPx * raster.scale + raster.originYPx
	}));
}

// ---------------------------------------------------------------------------
// Canvas crop — the only DOM-touching piece. Browser-only, deliberately not
// unit tested directly (jsdom's canvas 2D context is stubbed to null; see
// `tests/setup.ts` and the same convention in `stitch/analysis.ts`'s
// `toAnalysisRaster`). `detectCorridorBends` above is what gets exercised
// with synthetic rasters instead.
// ---------------------------------------------------------------------------

export interface CropHoleRasterOptions {
	/** Padding around the tee/basket bounding box, as a fraction of their straight-line distance. */
	readonly marginFraction?: number;
	readonly minMarginPx?: number;
	readonly maxMarginPx?: number;
	/** Crop is downscaled (via `scale`) to keep its longer side under this many pixels. */
	readonly maxDim?: number;
}

const DEFAULT_CROP_OPTIONS: Required<CropHoleRasterOptions> = {
	marginFraction: 0.4,
	minMarginPx: 40,
	maxMarginPx: 260,
	maxDim: 480
};

/** Crops a small RGBA region of `image` around one hole's tee and basket, in source-image pixel space. Returns null if canvas 2D is unavailable or the crop would be degenerate. */
export function cropSourceRasterAroundHole(
	image: HTMLImageElement,
	imageWidthPx: number,
	imageHeightPx: number,
	tee: SourcePoint,
	basket: SourcePoint,
	options: CropHoleRasterOptions = {}
): CorridorBendRaster | null {
	if (typeof document === 'undefined') return null;
	const { marginFraction, minMarginPx, maxMarginPx, maxDim } = { ...DEFAULT_CROP_OPTIONS, ...options };
	const distance = Math.hypot(basket.xPx - tee.xPx, basket.yPx - tee.yPx);
	const margin = Math.min(maxMarginPx, Math.max(minMarginPx, distance * marginFraction));
	const x0 = Math.max(0, Math.floor(Math.min(tee.xPx, basket.xPx) - margin));
	const y0 = Math.max(0, Math.floor(Math.min(tee.yPx, basket.yPx) - margin));
	const x1 = Math.min(imageWidthPx, Math.ceil(Math.max(tee.xPx, basket.xPx) + margin));
	const y1 = Math.min(imageHeightPx, Math.ceil(Math.max(tee.yPx, basket.yPx) + margin));
	const cropWidth = x1 - x0;
	const cropHeight = y1 - y0;
	if (cropWidth < 2 || cropHeight < 2) return null;

	const scale = Math.max(1, Math.max(cropWidth, cropHeight) / maxDim);
	const outWidth = Math.max(1, Math.round(cropWidth / scale));
	const outHeight = Math.max(1, Math.round(cropHeight / scale));

	const canvas = document.createElement('canvas');
	canvas.width = outWidth;
	canvas.height = outHeight;
	const context = canvas.getContext('2d');
	if (!context) return null;
	context.drawImage(image, x0, y0, cropWidth, cropHeight, 0, 0, outWidth, outHeight);
	const imageData = context.getImageData(0, 0, outWidth, outHeight);

	return {
		widthPx: outWidth,
		heightPx: outHeight,
		originXPx: x0,
		originYPx: y0,
		scale: cropWidth / outWidth,
		data: imageData.data,
		channels: 4
	};
}

// ---------------------------------------------------------------------------
// Integration glue — pure, so the "don't clobber existing bends" rule is
// unit-testable without a raster at all.
// ---------------------------------------------------------------------------

/**
 * Applies detected `bends` to `holeId`, in order, via the same
 * `addCorridorBend` primitive a manual placement uses — UNLESS the hole is
 * missing a tee/basket or already has at least one bend (the "don't clobber
 * manual work" rule: a hole the user already touched via "+ Add Bend(s)"
 * before approving must never have automatic proposals layered on top). A
 * no-op returns a fresh array, matching this codebase's pure-reducer
 * convention (see `holeAnnotation.ts`).
 */
export function applyDetectedCorridorBends(
	holes: readonly AnnotatedHole[],
	holeId: string,
	bends: readonly SourcePoint[]
): AnnotatedHole[] {
	const hole = holes.find((candidate) => candidate.id === holeId);
	if (!hole?.tee || !hole.basket || hole.corridorBends.length > 0 || bends.length === 0) {
		return holes.slice();
	}
	return bends.reduce((acc, bend) => addCorridorBend(acc, holeId, bend), holes as AnnotatedHole[]);
}
