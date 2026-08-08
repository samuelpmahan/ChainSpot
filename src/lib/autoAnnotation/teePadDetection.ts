/**
 * Tee-pad proposal detection for the clean UDisc-style course map fixture.
 *
 * This is intentionally worker-only code: its caller supplies an already
 * decoded RGBA analysis raster and the OpenCV instance owned by that worker.
 * It does not load WASM, decode images, or mutate editor state. Coordinates
 * returned from this module are always in original source-image pixels.
 *
 * The two detectors are a direct browser port of the successful CV probe:
 *
 * - a low-saturation, mid-gray rectangular pad interior; and
 * - a small rectangular Canny edge loop with a bright rim and gray interior.
 *
 * Each detector misses a different pair in the clean 18-hole fixture, so
 * candidates within one pad radius are fused rather than choosing either one.
 */

export type TeePadSupport = 'gray-center' | 'edge-loop' | 'occluded-edge-loop';

export type TeePadVariant = 'gray-center' | 'edge-loop' | 'fused';

export interface TeePadCandidate {
	/** Source-image center, in pixels. */
	readonly xPx: number;
	readonly yPx: number;
	/** Major-axis direction, normalized to [0, 180). */
	readonly orientationDeg: number;
	/** Source-image dimensions of the fitted rotated rectangle. */
	readonly widthPx: number;
	readonly heightPx: number;
	/**
	 * The probe's visual score. It is useful for ranking candidates from the
	 * same detector, but the support array is the stronger confidence signal.
	 */
	readonly score: number;
	readonly support: readonly TeePadSupport[];
}

/**
 * Lightweight per-detector diagnostics showing how many candidates survive
 * major filter stages. Exact fields vary by detector.
 */
export interface TeePadStageCounts {
	readonly discovered: number;
	readonly segments?: number;
	readonly pairs?: number;
	readonly parallel?: number;
	readonly geometry?: number;
	readonly masked?: number;
	readonly area?: number;
	readonly size?: number;
	readonly aspect?: number;
	readonly rectangularity?: number;
	readonly visual?: number;
	readonly grayCenter?: number;
	readonly edgeLoop?: number;
	readonly final: number;
}

export interface TeePadVariantResult {
	readonly variant: TeePadVariant;
	readonly candidates: readonly TeePadCandidate[];
	readonly stageCounts: TeePadStageCounts;
}

export interface OccludedEdgeLoopResult {
	readonly variant: 'occluded-edge-loop';
	readonly candidates: readonly TeePadCandidate[];
	readonly stageCounts: TeePadStageCounts;
}

/**
 * A raster at any analysis resolution. `sourceScale` is source pixels per
 * raster pixel: use `1` for full resolution and `1 / analysisScale` after a
 * downsample. The bytes are standard RGBA row-major pixels.
 */
export interface TeePadRaster {
	readonly rgba: Uint8Array | Uint8ClampedArray;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly sourceScale: number;
}

export interface TeePadDetectionOptions {
	/**
	 * Source-image pixels per UI icon scale. The number-badge detector already
	 * derives this in the static parser; pass that value here unchanged.
	 */
	readonly uiScalePx: number;
	/** Optional source-image vertical map extent. Everything outside is ignored. */
	readonly mapBoundsPx?: Readonly<{ topPx: number; bottomPx: number }>;
	/** Keep at most this many fused proposals. Defaults to the 18-hole MVP. */
	readonly maxCandidates?: number;
	/** Optional source-image circles whose Canny pixels should be ignored. */
	readonly ignoreCirclesPx?: readonly Readonly<{ xPx: number; yPx: number; radiusPx: number }>[];
}

type CvMat = {
	readonly rows: number;
	readonly cols: number;
	readonly data: Uint8Array;
	readonly data32S?: Int32Array;
	delete(): void;
};

type CvMatVector = {
	size(): number;
	get(index: number): CvMat;
	delete(): void;
};

type CvSize = unknown;

type CvRotatedRect = {
	readonly center: Readonly<{ x: number; y: number }>;
	readonly size: Readonly<{ width: number; height: number }>;
	readonly angle: number;
};

/** Narrow OpenCV surface used by this detector; the worker's loaded module satisfies it. */
export interface TeePadCv {
	Mat: new (rows?: number, cols?: number, type?: number) => CvMat;
	MatVector: new () => CvMatVector;
	Size: new (width: number, height: number) => CvSize;
	CV_8UC1: number;
	RETR_LIST: number;
	CHAIN_APPROX_SIMPLE: number;
	BORDER_DEFAULT: number;
	GaussianBlur(
		source: CvMat,
		destination: CvMat,
		kernel: CvSize,
		sigmaX: number,
		sigmaY?: number,
		borderType?: number
	): void;
	Canny(source: CvMat, destination: CvMat, threshold1: number, threshold2: number): void;
	findContours(
		source: CvMat,
		contours: CvMatVector,
		hierarchy: CvMat,
		mode: number,
		method: number
	): void;
	contourArea(contour: CvMat): number;
	arcLength(curve: CvMat, closed: boolean): number;
	approxPolyDP(curve: CvMat, approximation: CvMat, epsilon: number, closed: boolean): void;
	minAreaRect(points: CvMat): CvRotatedRect;
	HoughLinesP(
		edges: CvMat,
		lines: CvMat,
		rho: number,
		theta: number,
		threshold: number,
		minLineLength: number,
		maxLineGap: number
	): void;
}

interface AnalysisCandidate {
	readonly x: number;
	readonly y: number;
	readonly orientationDeg: number;
	readonly width: number;
	readonly height: number;
	readonly score: number;
	readonly support: TeePadSupport;
}

interface HsvPlanes {
	readonly gray: Uint8Array;
	readonly saturation: Uint8Array;
	readonly value: Uint8Array;
}

interface VisualStats {
	readonly borderValue: number;
	readonly innerValue: number;
	readonly innerSaturation: number;
}

interface AnalysisContext {
	readonly cv: TeePadCv;
	readonly raster: TeePadRaster;
	readonly scale: number;
	readonly rows: { first: number; last: number };
	readonly gray: Uint8Array;
	readonly saturation: Uint8Array;
	readonly value: Uint8Array;
}

interface HoughSegment {
	readonly x1: number;
	readonly y1: number;
	readonly x2: number;
	readonly y2: number;
}

interface OccludedPair {
	readonly centerX: number;
	readonly centerY: number;
	readonly major: number;
	readonly minor: number;
	readonly angleDeg: number;
	readonly angleDeltaDeg: number;
	readonly overlap: number;
	readonly firstLength: number;
	readonly secondLength: number;
}

const DEFAULT_MAX_CANDIDATES = 18;
const MAX_EDGE_CANDIDATES = 16;
const EXPERIMENT_MAX_CANDIDATES = 30;

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.max(minimum, Math.min(maximum, value));
}

function normalizeOrientation(angleDeg: number): number {
	const normalized = angleDeg % 180;
	return normalized < 0 ? normalized + 180 : normalized;
}

function rectDimensions(rect: CvRotatedRect): { major: number; minor: number; orientationDeg: number } {
	const width = rect.size.width;
	const height = rect.size.height;
	if (width >= height) {
		return { major: width, minor: height, orientationDeg: normalizeOrientation(rect.angle) };
	}
	return { major: height, minor: width, orientationDeg: normalizeOrientation(rect.angle + 90) };
}

function sourceCandidate(candidate: AnalysisCandidate, sourceScale: number): TeePadCandidate {
	return {
		xPx: candidate.x * sourceScale,
		yPx: candidate.y * sourceScale,
		orientationDeg: candidate.orientationDeg,
		widthPx: candidate.width * sourceScale,
		heightPx: candidate.height * sourceScale,
		score: candidate.score,
		support: [candidate.support]
	};
}

function readHsv(raster: TeePadRaster): HsvPlanes {
	const pixelCount = raster.widthPx * raster.heightPx;
	const gray = new Uint8Array(pixelCount);
	const saturation = new Uint8Array(pixelCount);
	const value = new Uint8Array(pixelCount);
	for (let pixel = 0, offset = 0; pixel < pixelCount; pixel += 1, offset += 4) {
		const red = raster.rgba[offset];
		const green = raster.rgba[offset + 1];
		const blue = raster.rgba[offset + 2];
		const maximum = Math.max(red, green, blue);
		const minimum = Math.min(red, green, blue);
		gray[pixel] = (red * 0.299 + green * 0.587 + blue * 0.114 + 0.5) | 0;
		value[pixel] = maximum;
		saturation[pixel] = maximum === 0 ? 0 : (((maximum - minimum) * 255) / maximum + 0.5) | 0;
	}
	return { gray, saturation, value };
}

function matFromBytes(cv: TeePadCv, bytes: Uint8Array, width: number, height: number): CvMat {
	const mat = new cv.Mat(height, width, cv.CV_8UC1);
	mat.data.set(bytes);
	return mat;
}

function findContours(cv: TeePadCv, mask: CvMat): { contours: CvMatVector; hierarchy: CvMat } {
	const contours = new cv.MatVector();
	const hierarchy = new cv.Mat();
	cv.findContours(mask, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
	return { contours, hierarchy };
}

function mapRows(
	raster: TeePadRaster,
	mapBoundsPx: TeePadDetectionOptions['mapBoundsPx']
): { first: number; last: number } | null {
	if (!mapBoundsPx) return { first: 0, last: raster.heightPx - 1 };
	const first = clamp(Math.ceil(mapBoundsPx.topPx / raster.sourceScale), 0, raster.heightPx - 1);
	const last = clamp(Math.floor(mapBoundsPx.bottomPx / raster.sourceScale), 0, raster.heightPx - 1);
	return first <= last ? { first, last } : null;
}

function insideRows(mask: Uint8Array, width: number, rows: { first: number; last: number }): void {
	for (let y = 0; y < rows.first; y += 1) mask.fill(0, y * width, (y + 1) * width);
	for (let y = rows.last + 1; y * width < mask.length; y += 1) {
		mask.fill(0, y * width, Math.min(mask.length, (y + 1) * width));
	}
}

/**
 * Equivalent to the probe's fillConvexPoly + two-pixel erosion, but sampled
 * directly so we do not allocate a full-image pair of temporary masks for
 * every tiny candidate rectangle.
 */
function rotatedRectVisualStats(
	rect: CvRotatedRect,
	width: number,
	height: number,
	saturation: Uint8Array,
	value: Uint8Array
): VisualStats | null {
	const halfWidth = rect.size.width * 0.5;
	const halfHeight = rect.size.height * 0.5;
	const innerHalfWidth = halfWidth - 2;
	const innerHalfHeight = halfHeight - 2;
	if (innerHalfWidth <= 0 || innerHalfHeight <= 0) return null;

	const radians = (rect.angle * Math.PI) / 180;
	const cosine = Math.cos(radians);
	const sine = Math.sin(radians);
	const extentX = Math.abs(halfWidth * cosine) + Math.abs(halfHeight * sine);
	const extentY = Math.abs(halfWidth * sine) + Math.abs(halfHeight * cosine);
	const xStart = clamp(Math.floor(rect.center.x - extentX), 0, width - 1);
	const xEnd = clamp(Math.ceil(rect.center.x + extentX), 0, width - 1);
	const yStart = clamp(Math.floor(rect.center.y - extentY), 0, height - 1);
	const yEnd = clamp(Math.ceil(rect.center.y + extentY), 0, height - 1);

	let borderValue = 0;
	let borderCount = 0;
	let innerValue = 0;
	let innerSaturation = 0;
	let innerCount = 0;
	for (let y = yStart; y <= yEnd; y += 1) {
		for (let x = xStart; x <= xEnd; x += 1) {
			const dx = x + 0.5 - rect.center.x;
			const dy = y + 0.5 - rect.center.y;
			const localX = dx * cosine + dy * sine;
			const localY = -dx * sine + dy * cosine;
			if (Math.abs(localX) > halfWidth || Math.abs(localY) > halfHeight) continue;
			const index = y * width + x;
			if (Math.abs(localX) <= innerHalfWidth && Math.abs(localY) <= innerHalfHeight) {
				innerValue += value[index];
				innerSaturation += saturation[index];
				innerCount += 1;
			} else {
				borderValue += value[index];
				borderCount += 1;
			}
		}
	}
	if (innerCount === 0 || borderCount === 0) return null;
	return {
		borderValue: borderValue / borderCount,
		innerValue: innerValue / innerCount,
		innerSaturation: innerSaturation / innerCount
	};
}

function tooClose(a: Pick<AnalysisCandidate, 'x' | 'y'>, b: Pick<AnalysisCandidate, 'x' | 'y'>, radius: number): boolean {
	return Math.hypot(a.x - b.x, a.y - b.y) < radius;
}

function candidateFromRect(
	rect: CvRotatedRect,
	score: number,
	support: TeePadSupport
): AnalysisCandidate {
	const dimensions = rectDimensions(rect);
	return {
		x: rect.center.x,
		y: rect.center.y,
		orientationDeg: dimensions.orientationDeg,
		width: dimensions.major,
		height: dimensions.minor,
		score,
		support
	};
}

function validateInputs(raster: TeePadRaster, options: TeePadDetectionOptions): void {
	if (!Number.isInteger(raster.widthPx) || !Number.isInteger(raster.heightPx) || raster.widthPx <= 0 || raster.heightPx <= 0) {
		throw new Error('Tee-pad detection received invalid raster dimensions.');
	}
	if (!Number.isFinite(raster.sourceScale) || raster.sourceScale <= 0) {
		throw new Error('Tee-pad detection requires a positive sourceScale.');
	}
	if (raster.rgba.length < raster.widthPx * raster.heightPx * 4) {
		throw new Error('Tee-pad detection raster does not contain RGBA pixels for its dimensions.');
	}
	if (!Number.isFinite(options.uiScalePx) || options.uiScalePx <= 0) {
		throw new Error('Tee-pad detection requires a positive uiScalePx.');
	}
	if (
		options.mapBoundsPx &&
		(!Number.isFinite(options.mapBoundsPx.topPx) || !Number.isFinite(options.mapBoundsPx.bottomPx))
	) {
		throw new Error('Tee-pad detection map bounds must be finite source-image pixels.');
	}
}

function buildContext(
	cv: TeePadCv,
	raster: TeePadRaster,
	options: TeePadDetectionOptions
): AnalysisContext {
	const rows = mapRows(raster, options.mapBoundsPx);
	if (!rows) {
		// Empty context: callers must short-circuit before using scale-dependent helpers.
		return {
			cv,
			raster,
			scale: options.uiScalePx / raster.sourceScale,
			rows: { first: 0, last: -1 },
			gray: new Uint8Array(0),
			saturation: new Uint8Array(0),
			value: new Uint8Array(0)
		};
	}
	const scale = options.uiScalePx / raster.sourceScale;
	const { gray, saturation, value } = readHsv(raster);
	return { cv, raster, scale, rows, gray, saturation, value };
}

function detectGrayCenterCandidates(
	ctx: AnalysisContext,
	maxCandidates: number
): { candidates: AnalysisCandidate[]; stageCounts: TeePadStageCounts } {
	const { cv, raster, scale, rows, saturation, value } = ctx;
	const centerMask = new Uint8Array(value.length);
	for (let index = 0; index < centerMask.length; index += 1) {
		centerMask[index] = saturation[index] < 18 && value[index] >= 148 && value[index] <= 168 ? 255 : 0;
	}
	insideRows(centerMask, raster.widthPx, rows);

	let discovered = 0;
	let areaAccepted = 0;
	let sizeAccepted = 0;
	let aspectAccepted = 0;
	let rectangularityAccepted = 0;
	const candidates: AnalysisCandidate[] = [];

	const centerMat = matFromBytes(cv, centerMask, raster.widthPx, raster.heightPx);
	try {
		const { contours, hierarchy } = findContours(cv, centerMat);
		try {
			discovered = contours.size();
			for (let index = 0; index < contours.size(); index += 1) {
				const contour = contours.get(index);
				try {
					const area = cv.contourArea(contour);
					if (area < 15 * scale * scale || area > 150 * scale * scale) continue;
					areaAccepted += 1;
					const rect = cv.minAreaRect(contour);
					const { major, minor } = rectDimensions(rect);
					if (minor < 2) continue;
					if (minor < 5 * scale || minor > 12 * scale || major < 8 * scale || major > 20 * scale) continue;
					sizeAccepted += 1;
					if (major / minor < 1.1 || major / minor > 3.0) continue;
					aspectAccepted += 1;
					const rectangularity = area / (major * minor);
					if (rectangularity < 0.6) continue;
					rectangularityAccepted += 1;
					candidates.push(candidateFromRect(rect, rectangularity, 'gray-center'));
				} finally {
					contour.delete();
				}
			}
		} finally {
			contours.delete();
			hierarchy.delete();
		}
	} finally {
		centerMat.delete();
	}

	candidates.sort((a, b) => b.score - a.score);
	const finalCandidates = candidates.slice(0, maxCandidates);
	return {
		candidates: finalCandidates,
		stageCounts: {
			discovered,
			area: areaAccepted,
			size: sizeAccepted,
			aspect: aspectAccepted,
			rectangularity: rectangularityAccepted,
			final: finalCandidates.length
		}
	};
}

function detectEdgeLoopCandidates(
	ctx: AnalysisContext,
	maxCandidates: number
): { candidates: AnalysisCandidate[]; stageCounts: TeePadStageCounts } {
	const { cv, raster, scale, rows, gray, saturation, value } = ctx;
	let discovered = 0;
	let sizeAccepted = 0;
	let rectangularityAccepted = 0;
	let visualAccepted = 0;

	const grayMat = matFromBytes(cv, gray, raster.widthPx, raster.heightPx);
	const blurred = new cv.Mat();
	const edges = new cv.Mat();
	try {
		const kernel = new cv.Size(3, 3);
		cv.GaussianBlur(grayMat, blurred, kernel, 0, 0, cv.BORDER_DEFAULT);
		cv.Canny(blurred, edges, 50, 150);
		insideRows(edges.data, raster.widthPx, rows);
		const { contours, hierarchy } = findContours(cv, edges);
		try {
			discovered = contours.size();
			const edgeCandidates: AnalysisCandidate[] = [];
			for (let index = 0; index < contours.size(); index += 1) {
				const contour = contours.get(index);
				const approximation = new cv.Mat();
				try {
					const perimeter = cv.arcLength(contour, true);
					cv.approxPolyDP(contour, approximation, 0.06 * perimeter, true);
					const area = Math.abs(cv.contourArea(contour));
					const rect = cv.minAreaRect(contour);
					const { major, minor } = rectDimensions(rect);
					if (minor < 1) continue;
					if (minor < 5.5 * scale || minor > 18 * scale || major < 8 * scale || major > 26 * scale) continue;
					sizeAccepted += 1;
					const rectangularity = area / (major * minor);
					if (approximation.rows > 6 || rectangularity < 0.45) continue;
					rectangularityAccepted += 1;

					const visual = rotatedRectVisualStats(
						rect,
						raster.widthPx,
						raster.heightPx,
						saturation,
						value
					);
					if (!visual || visual.borderValue < 145) continue;
					visualAccepted += 1;
					const contrast = visual.borderValue - visual.innerValue;
					const score =
						1.5 * rectangularity -
						0.05 * Math.abs(major - 13 * scale) -
						0.05 * Math.abs(minor - 8 * scale) -
						0.018 * Math.max(0, visual.innerSaturation - 10) -
						0.015 * Math.abs(visual.innerValue - 165) +
						0.012 * Math.max(0, visual.borderValue - 150) +
						0.006 * Math.max(0, contrast) -
						0.1 * Math.max(0, approximation.rows - 4);
					edgeCandidates.push(candidateFromRect(rect, score, 'edge-loop'));
				} finally {
					approximation.delete();
					contour.delete();
				}
			}
			edgeCandidates.sort((a, b) => b.score - a.score);
			const candidates: AnalysisCandidate[] = [];
			for (const candidate of edgeCandidates) {
				if (candidates.some((kept) => tooClose(candidate, kept, 7 * scale))) continue;
				candidates.push(candidate);
				if (candidates.length === maxCandidates) break;
			}
			return {
				candidates,
				stageCounts: { discovered, size: sizeAccepted, rectangularity: rectangularityAccepted, visual: visualAccepted, final: candidates.length }
			};
		} finally {
			contours.delete();
			hierarchy.delete();
		}
	} finally {
		grayMat.delete();
		blurred.delete();
		edges.delete();
	}
}

function segmentLength(segment: HoughSegment): number {
	return Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1);
}

function segmentAngle(segment: HoughSegment): number {
	return normalizeOrientation((Math.atan2(segment.y2 - segment.y1, segment.x2 - segment.x1) * 180) / Math.PI);
}

function houghSegments(lines: CvMat): HoughSegment[] {
	const values = lines.data32S;
	if (!values) return [];
	const segments: HoughSegment[] = [];
	for (let index = 0; index + 3 < values.length; index += 4) {
		const segment = {
			x1: values[index],
			y1: values[index + 1],
			x2: values[index + 2],
			y2: values[index + 3]
		};
		if (segmentLength(segment) > 0) segments.push(segment);
	}
	return segments;
}

function maskIgnoredCircles(
	edges: Uint8Array,
	width: number,
	height: number,
	sourceScale: number,
	circles: TeePadDetectionOptions['ignoreCirclesPx']
): number {
	if (!circles || circles.length === 0) return 0;
	for (const circle of circles) {
		const centerX = circle.xPx / sourceScale;
		const centerY = circle.yPx / sourceScale;
		const radius = circle.radiusPx / sourceScale;
		if (!Number.isFinite(centerX) || !Number.isFinite(centerY) || !Number.isFinite(radius) || radius <= 0) continue;
		const radiusSquared = radius * radius;
		const firstX = clamp(Math.floor(centerX - radius), 0, width - 1);
		const lastX = clamp(Math.ceil(centerX + radius), 0, width - 1);
		const firstY = clamp(Math.floor(centerY - radius), 0, height - 1);
		const lastY = clamp(Math.ceil(centerY + radius), 0, height - 1);
		for (let y = firstY; y <= lastY; y += 1) {
			for (let x = firstX; x <= lastX; x += 1) {
				const dx = x - centerX;
				const dy = y - centerY;
				if (dx * dx + dy * dy <= radiusSquared) edges[y * width + x] = 0;
			}
		}
	}
	return circles.length;
}

function occludedPair(
	first: HoughSegment,
	second: HoughSegment,
	sourceScale: number
): OccludedPair | null {
	const firstLength = segmentLength(first);
	const secondLength = segmentLength(second);
	const minimumSegmentLength = 5 / sourceScale;
	if (firstLength < minimumSegmentLength || secondLength < minimumSegmentLength) return null;

	const firstUx = (first.x2 - first.x1) / firstLength;
	const firstUy = (first.y2 - first.y1) / firstLength;
	let secondUx = (second.x2 - second.x1) / secondLength;
	let secondUy = (second.y2 - second.y1) / secondLength;
	const directionDot = firstUx * secondUx + firstUy * secondUy;
	if (directionDot < 0) {
		secondUx = -secondUx;
		secondUy = -secondUy;
	}
	const alignedDot = clamp(firstUx * secondUx + firstUy * secondUy, -1, 1);
	const angleDeltaDeg = (Math.acos(alignedDot) * 180) / Math.PI;
	if (angleDeltaDeg > 10) return null;

	const directionLength = Math.hypot(firstUx + secondUx, firstUy + secondUy);
	if (directionLength <= 1e-6) return null;
	const ux = (firstUx + secondUx) / directionLength;
	const uy = (firstUy + secondUy) / directionLength;
	const nx = -uy;
	const ny = ux;

	const firstStart = { x: first.x1, y: first.y1 };
	const firstEnd = { x: first.x2, y: first.y2 };
	const secondStart = { x: second.x1, y: second.y1 };
	const secondEnd = { x: second.x2, y: second.y2 };
	const projection = (point: { x: number; y: number }): number => point.x * ux + point.y * uy;
	const firstRange = [projection(firstStart), projection(firstEnd)].sort((a, b) => a - b);
	const secondRange = [projection(secondStart), projection(secondEnd)].sort((a, b) => a - b);
	const overlap = Math.min(firstRange[1], secondRange[1]) - Math.max(firstRange[0], secondRange[0]);
	if (overlap < 0.35 * Math.min(firstLength, secondLength)) return null;

	const major = Math.max(firstRange[1], secondRange[1]) - Math.min(firstRange[0], secondRange[0]);
	const majorMinimum = 16 / sourceScale;
	const majorMaximum = 20 / sourceScale;
	if (major < majorMinimum || major > majorMaximum) return null;

	const firstMidpoint = { x: (first.x1 + first.x2) * 0.5, y: (first.y1 + first.y2) * 0.5 };
	const secondMidpoint = { x: (second.x1 + second.x2) * 0.5, y: (second.y1 + second.y2) * 0.5 };
	const separation = Math.abs(
		(secondMidpoint.x - firstMidpoint.x) * nx + (secondMidpoint.y - firstMidpoint.y) * ny
	);
	const separationMinimum = 5 / sourceScale;
	const separationMaximum = 8.5 / sourceScale;
	if (separation < separationMinimum || separation > separationMaximum) return null;

	const centerAlong = (Math.min(firstRange[0], secondRange[0]) + Math.max(firstRange[1], secondRange[1])) * 0.5;
	const centerAcross =
		((firstMidpoint.x + secondMidpoint.x) * 0.5) * nx + ((firstMidpoint.y + secondMidpoint.y) * 0.5) * ny;
	return {
		centerX: centerAlong * ux + centerAcross * nx,
		centerY: centerAlong * uy + centerAcross * ny,
		major,
		minor: separation,
		angleDeg: normalizeOrientation((Math.atan2(uy, ux) * 180) / Math.PI),
		angleDeltaDeg,
		overlap,
		firstLength,
		secondLength
	};
}

function occludedPairScore(pair: OccludedPair, visual: VisualStats): number {
	const lengthFit = clamp(1 - Math.abs(pair.major - 18) / 2, 0, 1);
	const separationFit = clamp(1 - Math.abs(pair.minor - 6.75) / 1.75, 0, 1);
	const parallelFit = clamp(1 - pair.angleDeltaDeg / 10, 0, 1);
	const overlapFit = clamp(pair.overlap / Math.min(pair.firstLength, pair.secondLength), 0, 1);
	const rimFit = clamp((visual.borderValue - 120) / 80, 0, 1);
	return 0.28 * lengthFit + 0.24 * separationFit + 0.18 * parallelFit + 0.18 * overlapFit + 0.12 * rimFit;
}

/**
 * Targeted recovery for tee pads whose outline is broken by Circle 2 or a
 * basket icon. It deliberately requires two short, roughly parallel rails and
 * never attempts to reconstruct a tee from one rail.
 */
export function detectOccludedEdgeLoopCandidates(
	cv: TeePadCv,
	raster: TeePadRaster,
	options: TeePadDetectionOptions
): OccludedEdgeLoopResult {
	validateInputs(raster, options);
	const rows = mapRows(raster, options.mapBoundsPx);
	if (!rows) return { variant: 'occluded-edge-loop', candidates: [], stageCounts: { discovered: 0, final: 0 } };

	const { gray, saturation, value } = readHsv(raster);
	const grayMat = matFromBytes(cv, gray, raster.widthPx, raster.heightPx);
	const blurred = new cv.Mat();
	const edges = new cv.Mat();
	const lines = new cv.Mat();
	try {
		const kernel = new cv.Size(3, 3);
		cv.GaussianBlur(grayMat, blurred, kernel, 0, 0, cv.BORDER_DEFAULT);
		cv.Canny(blurred, edges, 50, 150);
		insideRows(edges.data, raster.widthPx, rows);
		const masked = maskIgnoredCircles(
			edges.data,
			raster.widthPx,
			raster.heightPx,
			raster.sourceScale,
			options.ignoreCirclesPx
		);

		const sourceScale = raster.sourceScale;
		cv.HoughLinesP(
			edges,
			lines,
			1,
			Math.PI / 180,
			8,
			5 / sourceScale,
			6 / sourceScale
		);
		const discoveredSegments = houghSegments(lines);
		const minimumSegmentLength = 5 / sourceScale;
		const maximumSegmentLength = 20 / sourceScale;
		const segments = discoveredSegments.filter((segment) => {
			const length = segmentLength(segment);
			return length >= minimumSegmentLength && length <= maximumSegmentLength;
		});
		const maximumPairDistance = 24 / sourceScale;
		const pairCellSize = maximumPairDistance;
		const angleBinCount = 18;
		const maximumSegmentsPerPairBucket = 12;
		const segmentAngles = segments.map((segment) => segmentAngle(segment));
		const pairBuckets = new Map<string, number[]>();
		for (let index = 0; index < segments.length; index += 1) {
			const segment = segments[index];
			const cellX = Math.floor(((segment.x1 + segment.x2) * 0.5) / pairCellSize);
			const cellY = Math.floor(((segment.y1 + segment.y2) * 0.5) / pairCellSize);
			const angleBin = Math.floor(segmentAngles[index] / 10);
			const key = `${cellX},${cellY},${angleBin}`;
			const bucket = pairBuckets.get(key);
			if (bucket) bucket.push(index);
			else pairBuckets.set(key, [index]);
		}
		for (const [key, bucket] of pairBuckets) {
			if (bucket.length <= maximumSegmentsPerPairBucket) continue;
			bucket.sort(
				(firstIndex, secondIndex) => segmentLength(segments[secondIndex]) - segmentLength(segments[firstIndex])
			);
			pairBuckets.set(key, bucket.slice(0, maximumSegmentsPerPairBucket));
		}
		let pairCount = 0;
		let parallelCount = 0;
		let geometryCount = 0;
		let visualCount = 0;
		const candidates: AnalysisCandidate[] = [];
		for (let firstIndex = 0; firstIndex < segments.length; firstIndex += 1) {
			const first = segments[firstIndex];
			const firstMidpointX = (first.x1 + first.x2) * 0.5;
			const firstMidpointY = (first.y1 + first.y2) * 0.5;
			const firstCellX = Math.floor(firstMidpointX / pairCellSize);
			const firstCellY = Math.floor(firstMidpointY / pairCellSize);
			const firstAngleBin = Math.floor(segmentAngles[firstIndex] / 10);
			for (let cellX = firstCellX - 1; cellX <= firstCellX + 1; cellX += 1) {
				for (let cellY = firstCellY - 1; cellY <= firstCellY + 1; cellY += 1) {
					for (let angleOffset = -1; angleOffset <= 1; angleOffset += 1) {
						const angleBin = (firstAngleBin + angleOffset + angleBinCount) % angleBinCount;
						const bucket = pairBuckets.get(`${cellX},${cellY},${angleBin}`);
						if (!bucket) continue;
						for (const secondIndex of bucket) {
							if (secondIndex <= firstIndex) continue;
							const second = segments[secondIndex];
							const secondMidpointX = (second.x1 + second.x2) * 0.5;
							const secondMidpointY = (second.y1 + second.y2) * 0.5;
							if (
								Math.hypot(secondMidpointX - firstMidpointX, secondMidpointY - firstMidpointY) >
								maximumPairDistance
							)
								continue;
							pairCount += 1;
							const firstAngle = segmentAngles[firstIndex];
							const secondAngle = segmentAngles[secondIndex];
							const angleDifference = Math.abs(firstAngle - secondAngle);
							const parallelDifference = Math.min(angleDifference, 180 - angleDifference);
							if (parallelDifference > 10) continue;
							parallelCount += 1;
							const pair = occludedPair(first, second, sourceScale);
							if (!pair) continue;
							geometryCount += 1;
							const visual = rotatedRectVisualStats(
								{
									center: { x: pair.centerX, y: pair.centerY },
									size: { width: pair.major, height: pair.minor },
									angle: pair.angleDeg
								},
								raster.widthPx,
								raster.heightPx,
								saturation,
								value
							);
							if (!visual || visual.borderValue < 145) continue;
							visualCount += 1;
							candidates.push({
								x: pair.centerX,
								y: pair.centerY,
								orientationDeg: pair.angleDeg,
								width: pair.major,
								height: pair.minor,
								score: occludedPairScore(pair, visual),
								support: 'occluded-edge-loop'
							});
						}
					}
				}
			}
		}

		candidates.sort((a, b) => b.score - a.score);
		const kept: AnalysisCandidate[] = [];
		const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
		if (!Number.isInteger(maxCandidates) || maxCandidates < 1) {
			throw new Error('Tee-pad detection maxCandidates must be a positive integer.');
		}
		for (const candidate of candidates) {
			if (kept.some((existing) => tooClose(candidate, existing, 7 * options.uiScalePx / sourceScale))) continue;
			kept.push(candidate);
			if (kept.length === maxCandidates) break;
		}
		return {
			variant: 'occluded-edge-loop',
			candidates: kept.map((candidate) => sourceCandidate(candidate, raster.sourceScale)),
			stageCounts: {
				discovered: discoveredSegments.length,
				segments: segments.length,
				pairs: pairCount,
				parallel: parallelCount,
				geometry: geometryCount,
				visual: visualCount,
				masked,
				final: kept.length
			}
		};
	} finally {
		grayMat.delete();
		blurred.delete();
		edges.delete();
		lines.delete();
	}
}

function fuseCandidates(
	detectorA: readonly AnalysisCandidate[],
	detectorB: readonly AnalysisCandidate[],
	raster: TeePadRaster,
	uiScalePx: number
): TeePadCandidate[] {
	const fused: TeePadCandidate[] = [];
	for (const candidate of [...detectorA, ...detectorB]) {
		const source = sourceCandidate(candidate, raster.sourceScale);
		const existingIndex = fused.findIndex((kept) => Math.hypot(source.xPx - kept.xPx, source.yPx - kept.yPx) < 7 * uiScalePx);
		if (existingIndex < 0) {
			fused.push(source);
			continue;
		}
		const existing = fused[existingIndex];
		const support = [...new Set([...existing.support, candidate.support])].sort() as TeePadSupport[];
		// The probe preserves the first detector's center, while retaining the
		// better score and both support signals when the detections coincide.
		fused[existingIndex] = { ...existing, score: Math.max(existing.score, candidate.score), support };
	}
	return fused;
}

function sortAndSliceFused(
	fused: TeePadCandidate[],
	maxCandidates: number
): readonly TeePadCandidate[] {
	return fused
		.sort((a, b) => b.support.length - a.support.length || b.score - a.score || a.yPx - b.yPx)
		.slice(0, maxCandidates);
}

const SIZE_CONSISTENCY_MIN_SAMPLE = 4;
const SIZE_CONSISTENCY_MIN_RELATIVE_GAP = 0.3;
const SIZE_CONSISTENCY_MIN_CLUSTER = 3;

/**
 * Finds the widest relative jump between consecutive sorted values and
 * returns the index of the first value above it (i.e. the boundary of the
 * upper cluster), or null when no jump looks like a real bimodal split.
 */
function largestRelativeGapSplit(sortedValues: readonly number[]): number | null {
	let bestIndex: number | null = null;
	let bestRelativeGap = SIZE_CONSISTENCY_MIN_RELATIVE_GAP;
	for (let index = 1; index < sortedValues.length; index += 1) {
		const previous = sortedValues[index - 1];
		const current = sortedValues[index];
		const relativeGap = (current - previous) / ((previous + current) / 2);
		if (relativeGap > bestRelativeGap) {
			bestRelativeGap = relativeGap;
			bestIndex = index;
		}
	}
	return bestIndex;
}

/**
 * On real (photographed/satellite) course captures, a course's C2 putting-circle
 * dashes produce short arc segments that pass the edge-loop/gray-center
 * rectangle filters but whose minor axis is roughly half a real tee pad's,
 * because a dash segment is much narrower than the pad interior. Worse, the
 * uncapped gray-center detector can find *more* dash artifacts than real
 * pads on one course, so a population average (mean/median) gets dragged
 * into the artifact range rather than describing the real pads. Instead,
 * look for a genuine bimodal split in minor-axis size and keep only the
 * larger-size cluster: real pads are the larger physical objects, dash
 * segments are consistently smaller, regardless of which group is more
 * numerous in the raw candidate pool.
 */
export function filterSizeConsistentCandidates(candidates: readonly TeePadCandidate[]): TeePadCandidate[] {
	if (candidates.length < SIZE_CONSISTENCY_MIN_SAMPLE) return [...candidates];
	const sortedHeights = candidates.map((candidate) => candidate.heightPx).sort((a, b) => a - b);
	const splitIndex = largestRelativeGapSplit(sortedHeights);
	if (splitIndex === null) return [...candidates];
	const minimumMinorAxis = sortedHeights[splitIndex];
	const upperCluster = candidates.filter((candidate) => candidate.heightPx >= minimumMinorAxis);
	// An implausibly small upper cluster likely means the gap was noise inside
	// one real cluster, not a genuine dash/pad split; keep everything rather
	// than risk discarding most of the real pads.
	if (upperCluster.length < SIZE_CONSISTENCY_MIN_CLUSTER) return [...candidates];
	return upperCluster;
}

/**
 * Detect tee-pad proposals from an RGBA raster inside the existing OpenCV
 * worker. The caller owns every Mat passed through `cv`; this function frees
 * all temporary Mats before it returns or throws.
 *
 * This is the fused entry point used by full-course detection. It fuses the
 * gray-center and edge-loop detectors, then drops fused candidates whose
 * minor axis is well under the size established by the rest of the set
 * (see `filterSizeConsistentCandidates`) before taking the top
 * `maxCandidates`, so a C2 dash artifact cannot displace a real pad from the
 * final slice.
 */
export function detectTeePadCandidates(
	cv: TeePadCv,
	raster: TeePadRaster,
	options: TeePadDetectionOptions
): readonly TeePadCandidate[] {
	validateInputs(raster, options);
	const rows = mapRows(raster, options.mapBoundsPx);
	if (!rows) return [];
	const scale = options.uiScalePx / raster.sourceScale;
	const { gray, saturation, value } = readHsv(raster);
	const ctx: AnalysisContext = { cv, raster, scale, rows, gray, saturation, value };
	const { candidates: detectorA } = detectGrayCenterCandidates(ctx, Infinity);
	const { candidates: detectorB } = detectEdgeLoopCandidates(ctx, MAX_EDGE_CANDIDATES);

	const fused = fuseCandidates(detectorA, detectorB, raster, options.uiScalePx);
	const sizeConsistent = filterSizeConsistentCandidates(fused);

	const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
	if (!Number.isInteger(maxCandidates) || maxCandidates < 1) {
		throw new Error('Tee-pad detection maxCandidates must be a positive integer.');
	}
	return sortAndSliceFused(sizeConsistent, maxCandidates);
}

/**
 * Run one or more tee-pad detector variants against the same raster and return
 * per-variant candidates plus lightweight stage counts. Used by the Detect tees
 * experiment surface. The fused variant preserves the same fusion used by
 * full-course detection.
 */
export function detectTeePadVariants(
	cv: TeePadCv,
	raster: TeePadRaster,
	options: TeePadDetectionOptions,
	variants: readonly TeePadVariant[]
): readonly TeePadVariantResult[] {
	validateInputs(raster, options);
	const rows = mapRows(raster, options.mapBoundsPx);
	if (!rows) {
		return variants.map((variant) => ({
			variant,
			candidates: [],
			stageCounts: { discovered: 0, final: 0 }
		}));
	}

	const scale = options.uiScalePx / raster.sourceScale;
	const { gray, saturation, value } = readHsv(raster);
	const ctx: AnalysisContext = { cv, raster, scale, rows, gray, saturation, value };

	const results: TeePadVariantResult[] = [];
	for (const variant of variants) {
		if (variant === 'gray-center') {
			const { candidates, stageCounts } = detectGrayCenterCandidates(ctx, EXPERIMENT_MAX_CANDIDATES);
			results.push({
				variant,
				candidates: candidates.map((candidate) => sourceCandidate(candidate, raster.sourceScale)),
				stageCounts
			});
		} else if (variant === 'edge-loop') {
			const { candidates, stageCounts } = detectEdgeLoopCandidates(ctx, EXPERIMENT_MAX_CANDIDATES);
			results.push({
				variant,
				candidates: candidates.map((candidate) => sourceCandidate(candidate, raster.sourceScale)),
				stageCounts
			});
		} else {
			const { candidates: detectorA, stageCounts: countsA } = detectGrayCenterCandidates(
				ctx,
				Infinity
			);
			const { candidates: detectorB, stageCounts: countsB } = detectEdgeLoopCandidates(
				ctx,
				MAX_EDGE_CANDIDATES
			);
			const fused = fuseCandidates(detectorA, detectorB, raster, options.uiScalePx);
			const sizeConsistent = filterSizeConsistentCandidates(fused);
			const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
			if (!Number.isInteger(maxCandidates) || maxCandidates < 1) {
				throw new Error('Tee-pad detection maxCandidates must be a positive integer.');
			}
			const candidates = sortAndSliceFused(sizeConsistent, maxCandidates);
			results.push({
				variant: 'fused',
				candidates,
				stageCounts: {
					discovered: countsA.final + countsB.final,
					grayCenter: countsA.final,
					edgeLoop: countsB.final,
					final: candidates.length
				}
			});
		}
	}
	return results;
}
