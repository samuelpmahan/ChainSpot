/**
 * MiddleOut: recovers the UDisc-rendered hole-path ribbon between two known
 * endpoints (badge<->tee, badge<->basket) as a browser-executable diagnostic.
 *
 * Ported from the validated Python reference,
 * `scripts/cv-probes/middleout/middleout.py` (`paired_bandness`,
 * `support_cost`, `route_leg`, `middleout_path`) -- read that file for the
 * algorithm's derivation and the dev-corpus results that validated it.
 *
 * The ribbon is not a real-world path: it is UDisc's own semi-transparent
 * rendered corridor graphic, alpha-composited over the satellite basemap
 * (see Linear doc "Working Model -- How UDisc Seems to Draw a Course Map").
 * That is exactly why this scores a pixel by comparing its two edges to each
 * other (paired, relative evidence) rather than to any fixed reference
 * color: the basemap underneath varies hole to hole, but both edges of one
 * ribbon slice sit on the same patch of basemap and shift together.
 *
 * This module does not decide which tee/badge/basket belongs to which hole
 * -- callers hand it already-owned endpoints and get a routed path back.
 */

import type { RawMaskBasket, RawMaskTee } from './rawObjectMask';
import type { P2LabeledBadge } from './rawObjectOwnership';
import type { P5SparseAssignmentResult } from './p5SparseAssignment';
import type { P6BasketCandidate, P6LowParBasketAssignmentResult } from './p6LowParBasketAssignment';
import type { CorridorBendRaster } from './corridorBendDetection';
import { BASKET_SPRITE_TIP_OFFSET_PX } from './pancakeCourseDisplay';

export type MiddleOutRaster = CorridorBendRaster;

export interface Point {
	readonly xPx: number;
	readonly yPx: number;
}

type CvMat = {
	readonly rows: number;
	readonly cols: number;
	readonly data: Uint8Array;
	readonly data32F?: Float32Array;
	convertTo(destination: CvMat, type: number): void;
	delete(): void;
};

type CvSize = unknown;

export interface MiddleOutCv {
	Mat: new (rows?: number, cols?: number, type?: number) => CvMat;
	Size: new (width: number, height: number) => CvSize;
	CV_8UC4: number;
	CV_8UC3: number;
	CV_32FC3: number;
	CV_32FC1: number;
	INTER_AREA: number;
	INTER_LINEAR: number;
	BORDER_DEFAULT: number;
	/** Matches the Python probe's `cv2.BORDER_REFLECT101` for `remap`; equal in value to `BORDER_DEFAULT`. */
	BORDER_REFLECT101: number;
	COLOR_RGBA2RGB: number;
	cvtColor(source: CvMat, destination: CvMat, code: number): void;
	resize(source: CvMat, destination: CvMat, size: CvSize, fx: number, fy: number, interpolation: number): void;
	GaussianBlur(
		source: CvMat,
		destination: CvMat,
		kernel: CvSize,
		sigmaX: number,
		sigmaY?: number,
		borderType?: number
	): void;
	remap(source: CvMat, destination: CvMat, map1: CvMat, map2: CvMat, interpolation: number, borderMode?: number): void;
}

/** Source pixels per support-field pixel -- matches the Python probe's `scale=3`. */
const DEFAULT_SCALE = 3;
/** Candidate ribbon widths, in SOURCE pixels -- matches the Python probe's `widths_src`. */
const DEFAULT_WIDTHS_SRC: readonly number[] = [24, 32, 40, 48, 56, 64];
const DEFAULT_ORIENTATIONS = 12;
const GAUSSIAN_SIGMA = 0.8;
const SUPPORT_PERCENTILE = 99.5;
const SUPPORT_GAMMA = 0.7;

export interface SupportField {
	/** Downsampled width/height -- `Math.floor(source / scale)`. */
	readonly widthPx: number;
	readonly heightPx: number;
	/** Source pixels per support-field pixel. */
	readonly scale: number;
	/** [0,1] paired-edge evidence, row-major, one value per support-field pixel. */
	readonly support: Float32Array;
	/** Source-px ribbon width that produced each pixel's `support` (the argmax, not discarded). 0 where no orientation/width scored positively. */
	readonly bestWidthPx: Float32Array;
	/** Orientation (degrees, [0,180)) that produced each pixel's `support`. 0 where no orientation/width scored positively. */
	readonly bestOrientationDeg: Float32Array;
	readonly elapsedMs: number;
}

function matFromRaster(cv: MiddleOutCv, raster: MiddleOutRaster): CvMat {
	const mat = new cv.Mat(raster.heightPx, raster.widthPx, raster.channels === 4 ? cv.CV_8UC4 : cv.CV_8UC3);
	mat.data.set(raster.data);
	return mat;
}

function percentile(sortedAscending: Float32Array, p: number): number {
	if (sortedAscending.length === 0) return 1;
	if (sortedAscending.length === 1) return sortedAscending[0];
	const rank = (p / 100) * (sortedAscending.length - 1);
	const lowIndex = Math.floor(rank);
	const highIndex = Math.ceil(rank);
	if (lowIndex === highIndex) return sortedAscending[lowIndex];
	const fraction = rank - lowIndex;
	return sortedAscending[lowIndex] * (1 - fraction) + sortedAscending[highIndex] * fraction;
}

/**
 * Continuous paired-edge evidence field: a candidate center pixel scores
 * when two approximately parallel edges, separated by a plausible ribbon
 * half-width, exhibit matching RGB transitions. Computed once per course
 * raster, never once per hole.
 */
export function computePairedEdgeSupportField(
	cv: MiddleOutCv,
	raster: MiddleOutRaster,
	options?: {
		readonly scale?: number;
		readonly widthsSrcPx?: readonly number[];
		readonly orientations?: number;
	}
): SupportField {
	const started = performance.now();
	const scale = options?.scale ?? DEFAULT_SCALE;
	const widthsSrcPx = options?.widthsSrcPx ?? DEFAULT_WIDTHS_SRC;
	const orientations = options?.orientations ?? DEFAULT_ORIENTATIONS;

	const ew = Math.max(1, Math.floor(raster.widthPx / scale));
	const eh = Math.max(1, Math.floor(raster.heightPx / scale));
	const pixelCount = ew * eh;

	const sourceMat = matFromRaster(cv, raster);
	const rgbMat = new cv.Mat();
	const smallMat = new cv.Mat();
	const floatMat = new cv.Mat();
	const blurredMat = new cv.Mat();
	const mapXMat = new cv.Mat(eh, ew, cv.CV_32FC1);
	const mapYMat = new cv.Mat(eh, ew, cv.CV_32FC1);
	const shiftedMat = new cv.Mat();

	try {
		if (raster.channels === 4) cv.cvtColor(sourceMat, rgbMat, cv.COLOR_RGBA2RGB);
		cv.resize(raster.channels === 4 ? rgbMat : sourceMat, smallMat, new cv.Size(ew, eh), 0, 0, cv.INTER_AREA);
		smallMat.convertTo(floatMat, cv.CV_32FC3);
		cv.GaussianBlur(floatMat, blurredMat, new cv.Size(0, 0), GAUSSIAN_SIGMA, GAUSSIAN_SIGMA, cv.BORDER_DEFAULT);

		const baseX = new Float32Array(pixelCount);
		const baseY = new Float32Array(pixelCount);
		for (let y = 0, i = 0; y < eh; y += 1) {
			for (let x = 0; x < ew; x += 1, i += 1) {
				baseX[i] = x;
				baseY[i] = y;
			}
		}

		const remapShift = (dx: number, dy: number, out: Float32Array): void => {
			const mapX = mapXMat.data32F!;
			const mapY = mapYMat.data32F!;
			for (let i = 0; i < pixelCount; i += 1) {
				mapX[i] = baseX[i] + dx;
				mapY[i] = baseY[i] + dy;
			}
			cv.remap(blurredMat, shiftedMat, mapXMat, mapYMat, cv.INTER_LINEAR, cv.BORDER_REFLECT101);
			out.set(shiftedMat.data32F!);
		};

		const halfWidths = widthsSrcPx.map((w) => w / (2 * scale));
		const delta = Math.max(1, 4 / scale);

		const best = new Float32Array(pixelCount);
		// Argmax (orientation, width) per pixel -- NOT discarded. A ribbon that
		// bends locally widens its footprint against a fixed set of test
		// orientations/widths, so this is a diagnostic curvature/bend signal in
		// its own right (see `sampleFieldAlongPath`). Deliberately not wired into
		// `routeLeg`'s cost yet -- see that function's doc comment.
		const bestWidthPx = new Float32Array(pixelCount);
		const bestOrientationDeg = new Float32Array(pixelCount);
		const leftInside = new Float32Array(pixelCount * 3);
		const leftOutside = new Float32Array(pixelCount * 3);
		const rightInside = new Float32Array(pixelCount * 3);
		const rightOutside = new Float32Array(pixelCount * 3);

		for (let o = 0; o < orientations; o += 1) {
			const theta = (o / orientations) * Math.PI;
			const thetaDeg = (o / orientations) * 180;
			const nx = -Math.sin(theta);
			const ny = Math.cos(theta);

			for (let widthIndex = 0; widthIndex < halfWidths.length; widthIndex += 1) {
				const r = halfWidths[widthIndex];
				remapShift(-nx * (r - delta), -ny * (r - delta), leftInside);
				remapShift(-nx * (r + delta), -ny * (r + delta), leftOutside);
				remapShift(nx * (r - delta), ny * (r - delta), rightInside);
				remapShift(nx * (r + delta), ny * (r + delta), rightOutside);

				for (let i = 0, c = 0; i < pixelCount; i += 1, c += 3) {
					const d1r = leftInside[c] - leftOutside[c];
					const d1g = leftInside[c + 1] - leftOutside[c + 1];
					const d1b = leftInside[c + 2] - leftOutside[c + 2];
					const d2r = rightInside[c] - rightOutside[c];
					const d2g = rightInside[c + 1] - rightOutside[c + 1];
					const d2b = rightInside[c + 2] - rightOutside[c + 2];

					const n1 = Math.sqrt(d1r * d1r + d1g * d1g + d1b * d1b);
					const n2 = Math.sqrt(d2r * d2r + d2g * d2g + d2b * d2b);
					const dot = d1r * d2r + d1g * d2g + d1b * d2b;
					const cosine = dot / (n1 * n2 + 1e-6);
					const agreement = cosine < 0 ? 0 : cosine > 1 ? 1 : cosine;
					const score = Math.min(n1, n2) * agreement;

					if (score > best[i]) {
						best[i] = score;
						bestWidthPx[i] = widthsSrcPx[widthIndex];
						bestOrientationDeg[i] = thetaDeg;
					}
				}
			}
		}

		let nonzeroCount = 0;
		for (let i = 0; i < pixelCount; i += 1) if (best[i] > 0) nonzeroCount += 1;
		let p995 = 1;
		if (nonzeroCount > 0) {
			const nonzero = new Float32Array(nonzeroCount);
			for (let i = 0, j = 0; i < pixelCount; i += 1) if (best[i] > 0) nonzero[j++] = best[i];
			nonzero.sort();
			p995 = Math.max(percentile(nonzero, SUPPORT_PERCENTILE), 1e-6);
		}

		const support = new Float32Array(pixelCount);
		for (let i = 0; i < pixelCount; i += 1) {
			const normalized = Math.min(Math.max(best[i] / p995, 0), 1);
			support[i] = normalized ** SUPPORT_GAMMA;
		}

		return { widthPx: ew, heightPx: eh, scale, support, bestWidthPx, bestOrientationDeg, elapsedMs: performance.now() - started };
	} finally {
		sourceMat.delete();
		rgbMat.delete();
		smallMat.delete();
		floatMat.delete();
		blurredMat.delete();
		mapXMat.delete();
		mapYMat.delete();
		shiftedMat.delete();
	}
}

const DEFAULT_ICON_CAP_RADIUS_SRC_PX = 32;
const DEFAULT_ICON_CAP_MAX_SUPPORT = 0.55;

/**
 * The basket sprite's own black-outline silhouette is a near-ceiling false
 * positive for paired-edge evidence -- its rigid parallel edges look exactly
 * like a ribbon (empirically confirmed: max support within a 75x75px window
 * around every basket on two dev-corpus courses was >=0.97, at a near-fixed
 * offset from the icon anchor). Since `buildSupportCost` turns support~=1
 * into a near-zero-cost sink, this is not just occlusion -- it can actively
 * pull a route onto the icon graphic instead of the true ribbon, especially
 * with a neighboring basket nearby. Clip support within an icon-footprint
 * radius of every known basket to a middling value: still cheap enough to
 * cross (matches the existing endpoint low-cost-disk intent) but no longer a
 * false attractor. Call this after `computePairedEdgeSupportField`, before
 * `buildSupportCost`. Mutates `field.support` in place.
 *
 * Not implemented here (validated but out of scope for this pass): a
 * bearing-biased partial waiver from the icon edge out to the basket's C1
 * ring radius, active only toward the incoming leg direction -- this is what
 * would stop a large near-basket low-cost zone from bleeding into a
 * neighboring hole's territory for close basket clusters (e.g. two baskets
 * whose C1 rings nearly touch). See
 * `scripts/cv-probes/middleout/basket_zone_experiment.py` for the validated
 * Python prototype (`route_leg_v2`, ring-radius detection via saturation-
 * channel radial profile) -- worth porting if cluster holes visibly
 * misroute during browser testing, not required for this icon-cap fix.
 */
export function capIconFalsePositives(
	field: SupportField,
	iconCentersSrcPx: readonly Point[],
	options?: { readonly radiusSrcPx?: number; readonly maxSupport?: number }
): void {
	const radius = (options?.radiusSrcPx ?? DEFAULT_ICON_CAP_RADIUS_SRC_PX) / field.scale;
	const maxSupport = options?.maxSupport ?? DEFAULT_ICON_CAP_MAX_SUPPORT;
	const radiusSq = radius * radius;
	for (const center of iconCentersSrcPx) {
		const cx = center.xPx / field.scale;
		const cy = center.yPx / field.scale;
		const x0 = Math.max(0, Math.floor(cx - radius));
		const x1 = Math.min(field.widthPx - 1, Math.ceil(cx + radius));
		const y0 = Math.max(0, Math.floor(cy - radius));
		const y1 = Math.min(field.heightPx - 1, Math.ceil(cy + radius));
		for (let y = y0; y <= y1; y += 1) {
			for (let x = x0; x <= x1; x += 1) {
				const dx = x - cx;
				const dy = y - cy;
				if (dx * dx + dy * dy > radiusSq) continue;
				const i = y * field.widthPx + x;
				if (field.support[i] > maxSupport) field.support[i] = maxSupport;
			}
		}
	}
}

/** Cost surface: cheap through high-support pixels, expensive elsewhere. */
export function buildSupportCost(support: Float32Array): Float32Array {
	const cost = new Float32Array(support.length);
	for (let i = 0; i < support.length; i += 1) {
		const gap = 1 - support[i];
		cost[i] = 1 + 4 * gap * gap;
	}
	return cost;
}

class MinHeap {
	private readonly heapIndex: Int32Array;
	private readonly priority: Float64Array;
	private size = 0;

	constructor(capacity: number) {
		this.heapIndex = new Int32Array(capacity);
		this.priority = new Float64Array(capacity);
	}

	get length(): number {
		return this.size;
	}

	push(index: number, dist: number): void {
		let i = this.size;
		this.heapIndex[i] = index;
		this.priority[i] = dist;
		this.size += 1;
		while (i > 0) {
			const parent = (i - 1) >> 1;
			if (this.priority[parent] <= this.priority[i]) break;
			this.swap(parent, i);
			i = parent;
		}
	}

	popMin(): { index: number; dist: number } {
		const topIndex = this.heapIndex[0];
		const topDist = this.priority[0];
		this.size -= 1;
		this.heapIndex[0] = this.heapIndex[this.size];
		this.priority[0] = this.priority[this.size];
		let i = 0;
		for (;;) {
			const left = i * 2 + 1;
			const right = left + 1;
			let smallest = i;
			if (left < this.size && this.priority[left] < this.priority[smallest]) smallest = left;
			if (right < this.size && this.priority[right] < this.priority[smallest]) smallest = right;
			if (smallest === i) break;
			this.swap(i, smallest);
			i = smallest;
		}
		return { index: topIndex, dist: topDist };
	}

	private swap(a: number, b: number): void {
		const ti = this.heapIndex[a];
		this.heapIndex[a] = this.heapIndex[b];
		this.heapIndex[b] = ti;
		const tp = this.priority[a];
		this.priority[a] = this.priority[b];
		this.priority[b] = tp;
	}
}

const NEIGHBOR_DX = [-1, 0, 1, -1, 1, -1, 0, 1];
const NEIGHBOR_DY = [-1, -1, -1, 0, 0, 1, 1, 1];
const NEIGHBOR_STEP = [Math.SQRT2, 1, Math.SQRT2, 1, 1, Math.SQRT2, 1, Math.SQRT2];

/** Waives cost near an endpoint so a badge/tee/basket glyph can't fully block a leg's start/end. */
export interface EndpointWaiveOptions {
	/** Radius, in cost-array (downsampled) pixels. Defaults to the Python probe's `r=6`. */
	readonly radiusPx?: number;
	/** Cost is clamped to at most this value inside the radius. Defaults to the Python probe's `1.4`. */
	readonly maxCost?: number;
}

const DEFAULT_ENDPOINT_RADIUS_PX = 6;
const DEFAULT_ENDPOINT_MAX_COST = 1.4;

function waiveEndpointCost(
	local: Float32Array,
	localWidth: number,
	localHeight: number,
	centerCol: number,
	centerRow: number,
	options: EndpointWaiveOptions | undefined
): void {
	const radius = options?.radiusPx ?? DEFAULT_ENDPOINT_RADIUS_PX;
	const maxCost = options?.maxCost ?? DEFAULT_ENDPOINT_MAX_COST;
	const radiusSq = radius * radius;
	const y0 = Math.max(0, Math.floor(centerRow - radius));
	const y1 = Math.min(localHeight - 1, Math.ceil(centerRow + radius));
	const x0 = Math.max(0, Math.floor(centerCol - radius));
	const x1 = Math.min(localWidth - 1, Math.ceil(centerCol + radius));
	for (let y = y0; y <= y1; y += 1) {
		for (let x = x0; x <= x1; x += 1) {
			const dx = x - centerCol;
			const dy = y - centerRow;
			if (dx * dx + dy * dy > radiusSq) continue;
			const i = y * localWidth + x;
			if (local[i] > maxCost) local[i] = maxCost;
		}
	}
}

export interface RouteLegOptions {
	readonly marginFraction?: number;
	readonly startWaive?: EndpointWaiveOptions;
	readonly goalWaive?: EndpointWaiveOptions;
}

/**
 * Bounded shortest path from one semantic anchor to another, in a generous
 * ROI around the start/end chord -- an 8-connected weighted Dijkstra with
 * geometric (not step-count) distance weighting, matching skimage's
 * `route_through_array(..., fully_connected=True, geometric=True)`. Returns
 * source-space (x,y) coordinates, or null if no path exists.
 *
 * Cost here is `support` only. `bestWidthPx`/`bestOrientationDeg` (the
 * paired-edge argmax per pixel, see `computePairedEdgeSupportField`) are
 * deliberately NOT folded into this cost yet: a real UDisc ribbon likely
 * widens its measured footprint at a genuine bend, so a turn unsupported by
 * local width expansion is a plausible candidate for a soft cost penalty --
 * but what that penalty should look like needs to be measured against how
 * the renderer actually draws bends first, not guessed. Wiring in a specific
 * formula before that measurement would just be a different unvalidated
 * guess in place of this one.
 */
export function routeLeg(
	cost: Float32Array,
	width: number,
	height: number,
	scale: number,
	start: Point,
	goal: Point,
	options?: RouteLegOptions
): Point[] | null {
	const sx = start.xPx / scale;
	const sy = start.yPx / scale;
	const gx = goal.xPx / scale;
	const gy = goal.yPx / scale;

	const marginFraction = options?.marginFraction ?? 0.6;
	const straight = Math.hypot(gx - sx, gy - sy);
	const margin = Math.max(30, straight * marginFraction);

	const x0 = Math.max(0, Math.floor(Math.min(sx, gx) - margin));
	const x1 = Math.min(width - 1, Math.ceil(Math.max(sx, gx) + margin));
	const y0 = Math.max(0, Math.floor(Math.min(sy, gy) - margin));
	const y1 = Math.min(height - 1, Math.ceil(Math.max(sy, gy) + margin));

	const localWidth = x1 - x0 + 1;
	const localHeight = y1 - y0 + 1;
	if (localWidth <= 0 || localHeight <= 0) return null;

	const local = new Float32Array(localWidth * localHeight);
	for (let y = 0; y < localHeight; y += 1) {
		const srcRow = (y + y0) * width;
		const dstRow = y * localWidth;
		for (let x = 0; x < localWidth; x += 1) {
			local[dstRow + x] = cost[srcRow + x + x0];
		}
	}

	const clampCol = (value: number): number => Math.max(0, Math.min(localWidth - 1, Math.round(value) - x0));
	const clampRow = (value: number): number => Math.max(0, Math.min(localHeight - 1, Math.round(value) - y0));

	const startCol = clampCol(sx);
	const startRow = clampRow(sy);
	const goalCol = clampCol(gx);
	const goalRow = clampRow(gy);

	waiveEndpointCost(local, localWidth, localHeight, startCol, startRow, options?.startWaive);
	waiveEndpointCost(local, localWidth, localHeight, goalCol, goalRow, options?.goalWaive);

	const startIndex = startRow * localWidth + startCol;
	const goalIndex = goalRow * localWidth + goalCol;
	if (startIndex === goalIndex) {
		return [
			{ xPx: (startCol + x0) * scale, yPx: (startRow + y0) * scale },
			{ xPx: (goalCol + x0) * scale, yPx: (goalRow + y0) * scale }
		];
	}

	const n = localWidth * localHeight;
	const dist = new Float64Array(n).fill(Infinity);
	const prev = new Int32Array(n).fill(-1);
	dist[startIndex] = 0;
	const visited = new Uint8Array(n);

	const heap = new MinHeap(n * 4);
	heap.push(startIndex, 0);

	while (heap.length > 0) {
		const { index, dist: d } = heap.popMin();
		if (visited[index]) continue;
		visited[index] = 1;
		if (index === goalIndex) break;
		if (d > dist[index]) continue;

		const x = index % localWidth;
		const y = (index - x) / localWidth;
		for (let k = 0; k < 8; k += 1) {
			const nx = x + NEIGHBOR_DX[k];
			const ny = y + NEIGHBOR_DY[k];
			if (nx < 0 || nx >= localWidth || ny < 0 || ny >= localHeight) continue;
			const neighborIndex = ny * localWidth + nx;
			if (visited[neighborIndex]) continue;
			const edgeWeight = 0.5 * (local[index] + local[neighborIndex]) * NEIGHBOR_STEP[k];
			const candidate = d + edgeWeight;
			if (candidate < dist[neighborIndex]) {
				dist[neighborIndex] = candidate;
				prev[neighborIndex] = index;
				heap.push(neighborIndex, candidate);
			}
		}
	}

	if (!Number.isFinite(dist[goalIndex])) return null;

	const path: Point[] = [];
	let cursor = goalIndex;
	for (;;) {
		const x = cursor % localWidth;
		const y = (cursor - x) / localWidth;
		path.push({ xPx: (x + x0) * scale, yPx: (y + y0) * scale });
		if (cursor === startIndex) break;
		cursor = prev[cursor];
	}
	path.reverse();
	return path;
}

export interface MiddleOutPathOptions {
	readonly marginFraction?: number;
	readonly teeWaive?: EndpointWaiveOptions;
	readonly badgeWaive?: EndpointWaiveOptions;
	readonly basketWaive?: EndpointWaiveOptions;
}

export interface MiddleOutPathResult {
	/** tee -> badge -> basket, in source-image pixels. */
	readonly dense: readonly Point[];
	readonly badgeToTee: readonly Point[];
	readonly badgeToBasket: readonly Point[];
}

/** Recovers tee -> badge -> basket as two independent middle-out legs. No bend truth is used. */
export function recoverMiddleOutPath(
	cost: Float32Array,
	width: number,
	height: number,
	scale: number,
	tee: Point,
	badge: Point,
	basket: Point,
	options?: MiddleOutPathOptions
): MiddleOutPathResult | null {
	const badgeToTee = routeLeg(cost, width, height, scale, badge, tee, {
		marginFraction: options?.marginFraction,
		startWaive: options?.badgeWaive,
		goalWaive: options?.teeWaive
	});
	if (!badgeToTee) return null;

	const badgeToBasket = routeLeg(cost, width, height, scale, badge, basket, {
		marginFraction: options?.marginFraction,
		startWaive: options?.badgeWaive,
		goalWaive: options?.basketWaive
	});
	if (!badgeToBasket) return null;

	const teeToBadge = [...badgeToTee].reverse();
	const dense = [...teeToBadge, ...badgeToBasket.slice(1)];
	return { dense, badgeToTee, badgeToBasket };
}

/** Mean support-field value sampled along a dense path -- a diagnostic confidence proxy, not a probability. */
/** Nearest-neighbor samples of any support-field-shaped raster (support, `bestWidthPx`, `bestOrientationDeg`, ...) along a dense path, in path order. */
export function sampleFieldAlongPath(
	path: readonly Point[],
	field: Float32Array,
	width: number,
	height: number,
	scale: number
): number[] {
	return path.map((point) => {
		const x = Math.max(0, Math.min(width - 1, Math.round(point.xPx / scale)));
		const y = Math.max(0, Math.min(height - 1, Math.round(point.yPx / scale)));
		return field[y * width + x];
	});
}

export function meanSupportAlongPath(
	path: readonly Point[],
	support: Float32Array,
	width: number,
	height: number,
	scale: number
): number {
	if (path.length === 0) return 0;
	const samples = sampleFieldAlongPath(path, support, width, height, scale);
	return samples.reduce((sum, value) => sum + value, 0) / samples.length;
}

export function pathLengthPx(path: readonly Point[]): number {
	let length = 0;
	for (let i = 1; i < path.length; i += 1) {
		length += Math.hypot(path[i].xPx - path[i - 1].xPx, path[i].yPx - path[i - 1].yPx);
	}
	return length;
}

/**
 * Translucent alternate endpoint hypothesis: same primary tee/badge/basket
 * except one endpoint swapped for a plausible runner-up. Never touches P5/P6
 * ownership -- purely a "what would this ribbon look like from here" probe.
 */
export interface MiddleOutAlternatePath {
	readonly endpoint: 'tee' | 'basket';
	/** `rankWithinHole` for a basket alternate; ordinal (2, 3, ...) for a tee alternate (P5 keeps no per-candidate rank). */
	readonly rank: number;
	/** False only for basket alternates P6 could not score (`lowParScore` was null/non-finite). */
	readonly valid: boolean;
	readonly candidateIndex: number;
	readonly dense: readonly Point[];
	readonly meanSupport: number;
}

export interface MiddleOutHoleResult {
	readonly holeNumber: number;
	readonly teeIndex: number;
	readonly basketIndex: number;
	readonly badge: Point;
	readonly dense: readonly Point[];
	readonly meanSupport: number;
	readonly pathLengthPx: number;
	readonly straightLinePx: number;
	readonly lengthRatio: number;
	readonly alternates: readonly MiddleOutAlternatePath[];
}

export interface MiddleOutCourseResult {
	readonly widthPx: number;
	readonly heightPx: number;
	readonly scale: number;
	readonly holes: readonly MiddleOutHoleResult[];
	readonly supportFieldMs: number;
	readonly pathsMs: number;
}

const MAX_ALTERNATES_PER_SIDE = 2;
const MAX_ALTERNATES_PER_HOLE = 2;

/** Pixel center of the rendered basket sprite; used only for sprite-support suppression. */
function toBasketSpriteCenter(basket: RawMaskBasket): Point {
	return { xPx: basket.centerXPx, yPx: basket.centerYPx };
}

/** Same semantic basket point published by `buildPancakeDisplayGrammar`. */
function toBasketPoint(basket: RawMaskBasket): Point {
	return { xPx: basket.xPx, yPx: basket.yPx + BASKET_SPRITE_TIP_OFFSET_PX };
}

function toTeePoint(tee: RawMaskTee): Point {
	return { xPx: tee.xPx, yPx: tee.yPx };
}

/**
 * Runs MiddleOut for every hole that already has a P2 badge, a P5-assigned
 * tee, and a P6-assigned basket -- the shared support field/cost surface is
 * computed once for the whole course, never once per hole. Also recovers a
 * bounded set of translucent alternate paths for holes with genuinely
 * ambiguous endpoint ownership, drawn from P6's full per-hole candidate pool
 * (including candidates it could not score, not just runners-up) and from a
 * reverse index over P5's per-tee candidate hole numbers -- both already
 * computed by P5/P6, no new detection.
 */
export function deriveMiddleOutDiagnostics(
	cv: MiddleOutCv,
	raster: MiddleOutRaster,
	tees: readonly RawMaskTee[],
	baskets: readonly RawMaskBasket[],
	badges: readonly P2LabeledBadge[],
	p5: P5SparseAssignmentResult,
	p6: P6LowParBasketAssignmentResult
): MiddleOutCourseResult {
	const field = computePairedEdgeSupportField(cv, raster);
	capIconFalsePositives(field, baskets.map(toBasketSpriteCenter));
	const cost = buildSupportCost(field.support);
	const support = (path: readonly Point[]) => meanSupportAlongPath(path, field.support, field.widthPx, field.heightPx, field.scale);

	const teeAssignmentByHole = new Map(
		p5.assignments.filter((a) => a.assignedHoleNumber !== null).map((a) => [a.assignedHoleNumber as number, a])
	);
	const basketAssignmentByHole = new Map(
		p6.assignments.filter((a) => a.assignedBasketIndex !== null).map((a) => [a.holeNumber, a])
	);
	const basketCandidatesByHole = new Map<number, P6BasketCandidate[]>();
	for (const candidate of p6.candidates) {
		const list = basketCandidatesByHole.get(candidate.holeNumber);
		if (list) list.push(candidate);
		else basketCandidatesByHole.set(candidate.holeNumber, [candidate]);
	}

	const pathsStarted = performance.now();
	const holes: MiddleOutHoleResult[] = [];

	for (const badge of badges) {
		const teeAssignment = teeAssignmentByHole.get(badge.holeNumber);
		const basketAssignment = basketAssignmentByHole.get(badge.holeNumber);
		if (!teeAssignment || !basketAssignment || basketAssignment.assignedBasketIndex === null) continue;

		const tee = tees[teeAssignment.teeIndex];
		const basket = baskets[basketAssignment.assignedBasketIndex];
		if (!tee || !basket) continue;

		const badgePoint: Point = { xPx: badge.xPx, yPx: badge.yPx };
		const teePoint = toTeePoint(tee);
		const basketPoint = toBasketPoint(basket);

		const primary = recoverMiddleOutPath(cost, field.widthPx, field.heightPx, field.scale, teePoint, badgePoint, basketPoint);
		if (!primary) continue;

		const alternates: MiddleOutAlternatePath[] = [];

		const basketAlternates = (basketCandidatesByHole.get(badge.holeNumber) ?? [])
			.filter((candidate) => candidate.rankWithinHole > 1)
			.sort((a, b) => a.rankWithinHole - b.rankWithinHole)
			.slice(0, MAX_ALTERNATES_PER_SIDE);
		for (const candidate of basketAlternates) {
			const altBasket = baskets[candidate.basketIndex];
			if (!altBasket) continue;
			const altPath = recoverMiddleOutPath(cost, field.widthPx, field.heightPx, field.scale, teePoint, badgePoint, toBasketPoint(altBasket));
			if (!altPath) continue;
			alternates.push({
				endpoint: 'basket',
				rank: candidate.rankWithinHole,
				valid: candidate.valid,
				candidateIndex: candidate.basketIndex,
				dense: altPath.dense,
				meanSupport: support(altPath.dense)
			});
		}

		const teeAlternates = p5.assignments
			.filter((a) => a.teeIndex !== teeAssignment.teeIndex && a.candidateHoleNumbers.includes(badge.holeNumber))
			.slice(0, MAX_ALTERNATES_PER_SIDE);
		for (const [index, alt] of teeAlternates.entries()) {
			const altTee = tees[alt.teeIndex];
			if (!altTee) continue;
			const altPath = recoverMiddleOutPath(cost, field.widthPx, field.heightPx, field.scale, toTeePoint(altTee), badgePoint, basketPoint);
			if (!altPath) continue;
			alternates.push({
				endpoint: 'tee',
				rank: index + 2,
				valid: true,
				candidateIndex: alt.teeIndex,
				dense: altPath.dense,
				meanSupport: support(altPath.dense)
			});
		}

		alternates.sort((a, b) => b.meanSupport - a.meanSupport);

		const lengthPx = pathLengthPx(primary.dense);
		const straightLinePx = pathLengthPx([teePoint, badgePoint, basketPoint]);
		holes.push({
			holeNumber: badge.holeNumber,
			teeIndex: teeAssignment.teeIndex,
			basketIndex: basketAssignment.assignedBasketIndex,
			badge: badgePoint,
			dense: primary.dense,
			meanSupport: support(primary.dense),
			pathLengthPx: lengthPx,
			straightLinePx,
			lengthRatio: straightLinePx > 0 ? lengthPx / straightLinePx : 1,
			alternates: alternates.slice(0, MAX_ALTERNATES_PER_HOLE)
		});
	}

	return {
		widthPx: field.widthPx,
		heightPx: field.heightPx,
		scale: field.scale,
		holes,
		supportFieldMs: field.elapsedMs,
		pathsMs: performance.now() - pathsStarted
	};
}
