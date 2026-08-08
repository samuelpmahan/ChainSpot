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

export type TeePadSupport = 'gray-center' | 'edge-loop';

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
}

type CvMat = {
	readonly rows: number;
	readonly cols: number;
	readonly data: Uint8Array;
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

const DEFAULT_MAX_CANDIDATES = 18;
const MAX_EDGE_CANDIDATES = 16;

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

/**
 * Detect tee-pad proposals from an RGBA raster inside the existing OpenCV
 * worker. The caller owns every Mat passed through `cv`; this function frees
 * all temporary Mats before it returns or throws.
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
	const centerMask = new Uint8Array(gray.length);
	for (let index = 0; index < centerMask.length; index += 1) {
		centerMask[index] = saturation[index] < 18 && value[index] >= 148 && value[index] <= 168 ? 255 : 0;
	}
	insideRows(centerMask, raster.widthPx, rows);

	const detectorA: AnalysisCandidate[] = [];
	const centerMat = matFromBytes(cv, centerMask, raster.widthPx, raster.heightPx);
	try {
		const { contours, hierarchy } = findContours(cv, centerMat);
		try {
			for (let index = 0; index < contours.size(); index += 1) {
				const contour = contours.get(index);
				try {
					const area = cv.contourArea(contour);
					if (area < 15 * scale * scale || area > 150 * scale * scale) continue;
					const rect = cv.minAreaRect(contour);
					const { major, minor } = rectDimensions(rect);
					if (minor < 2) continue;
					if (minor < 5 * scale || minor > 12 * scale || major < 8 * scale || major > 20 * scale) continue;
					if (major / minor < 1.1 || major / minor > 3.0) continue;
					const rectangularity = area / (major * minor);
					if (rectangularity < 0.6) continue;
					detectorA.push(candidateFromRect(rect, rectangularity, 'gray-center'));
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

	const detectorB: AnalysisCandidate[] = [];
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
					const rectangularity = area / (major * minor);
					if (approximation.rows > 6 || rectangularity < 0.45) continue;

					const visual = rotatedRectVisualStats(
						rect,
						raster.widthPx,
						raster.heightPx,
						saturation,
						value
					);
					if (!visual || visual.borderValue < 145) continue;
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
			for (const candidate of edgeCandidates) {
				if (detectorB.some((kept) => tooClose(candidate, kept, 7 * scale))) continue;
				detectorB.push(candidate);
				if (detectorB.length === MAX_EDGE_CANDIDATES) break;
			}
		} finally {
			contours.delete();
			hierarchy.delete();
		}
	} finally {
		grayMat.delete();
		blurred.delete();
		edges.delete();
	}

	const fused: TeePadCandidate[] = [];
	for (const candidate of [...detectorA, ...detectorB]) {
		const source = sourceCandidate(candidate, raster.sourceScale);
		const existingIndex = fused.findIndex((kept) => Math.hypot(source.xPx - kept.xPx, source.yPx - kept.yPx) < 7 * options.uiScalePx);
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

	const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
	if (!Number.isInteger(maxCandidates) || maxCandidates < 1) {
		throw new Error('Tee-pad detection maxCandidates must be a positive integer.');
	}
	return fused
		.sort((a, b) => b.support.length - a.support.length || b.score - a.score || a.yPx - b.yPx)
		.slice(0, maxCandidates);
}
