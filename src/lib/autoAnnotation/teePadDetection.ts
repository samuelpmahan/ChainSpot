import type { HoleNumberScaleAnchor } from './holeNumberDetection';
import { deriveCanonicalUiScalePx } from './cvCalibration';
import type { UiScalePx } from './cvCalibration';
import type { Candidate, CvRaster } from '../cv/types';

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

export type TeePadSupport = 'gray-center' | 'edge-loop' | 'occluded-edge-loop' | 'template-search';

export type TeeCandidateTier = 'primary' | 'occluded' | 'weak-template' | 'masked-recovery';

export interface TeeCandidateProvenance {
	readonly tier: TeeCandidateTier;
	readonly support: TeePadSupport;
}

export type TeePadVariant = 'gray-center' | 'edge-loop' | 'fused';

/** xPx/yPx (from `Candidate`) are the fitted rectangle's source-image center. */
export interface TeePadCandidate extends Candidate {
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
	/** Detector/recovery sources retained when physical hypotheses are merged. */
	readonly provenance?: readonly TeeCandidateProvenance[];
}

export type TeePadNumberAnchor = Pick<HoleNumberScaleAnchor, 'widthPx' | 'heightPx'>;

/**
 * Convert a measured number badge into source-image pixels per canonical UDisc
 * UI scale. The hole-number detector's `scale` is intentionally not part of
 * this conversion: it is only the resize multiplier for the supplied template.
 */
export function deriveTeePadUiScalePx(
	numberAnchor: TeePadNumberAnchor | null | undefined,
	fallbackUiScalePx?: number
): number | undefined {
	if (!numberAnchor) return fallbackUiScalePx;
	return deriveCanonicalUiScalePx(numberAnchor.widthPx, numberAnchor.heightPx);
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
export interface TeePadRaster extends CvRaster {
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
	readonly uiScalePx: UiScalePx;
	/** Optional source-image vertical map extent. Everything outside is ignored. */
	readonly mapBoundsPx?: Readonly<{ topPx: number; bottomPx: number }>;
	/** Keep at most this many fused proposals. Defaults to the 18-hole MVP. */
	readonly maxCandidates?: number;
	/**
	 * Optional source-image circles whose Canny pixels should be ignored.
	 * `innerRadiusPx` narrows the masked region to an annulus (defaults to 0,
	 * i.e. the full disc) -- use an annulus when a real structure, such as a
	 * neighboring hole's own tee pad, can legitimately sit inside another
	 * circle's interior; a full-disc mask would erase it along with the ring.
	 */
	readonly ignoreCirclesPx?: readonly Readonly<{
		xPx: number;
		yPx: number;
		radiusPx: number;
		innerRadiusPx?: number;
	}>[];
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

/**
 * Undirected orientations wrap at 180degrees, so two segments on the same
 * line can legitimately read ~0 and ~180 depending on which endpoint Hough
 * returned first -- a plain arithmetic mean of those is ~90, a spurious
 * right angle to the real line. Averaging the doubled angle as a unit
 * vector (period 360, no wraparound ambiguity) and halving the result back
 * down avoids that.
 */
function circularMeanOrientationDeg(anglesDeg: readonly number[]): number {
	let sumX = 0;
	let sumY = 0;
	for (const angleDeg of anglesDeg) {
		const doubledRadians = (angleDeg * 2 * Math.PI) / 180;
		sumX += Math.cos(doubledRadians);
		sumY += Math.sin(doubledRadians);
	}
	const meanDoubledDeg = (Math.atan2(sumY, sumX) * 180) / Math.PI;
	return normalizeOrientation(meanDoubledDeg / 2);
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
 * The probe's fixed 2px interior erosion, expressed as a UI-scale-relative
 * coefficient so it derives from `scale` instead of assuming one resolution.
 * At the nominal uiScalePx of 1.77 this reproduces the historical 2px exactly.
 */
const VISUAL_EROSION_UI = 2 / 1.77;

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
	value: Uint8Array,
	scale: number
): VisualStats | null {
	const halfWidth = rect.size.width * 0.5;
	const halfHeight = rect.size.height * 0.5;
	const erosionPx = Math.max(1, VISUAL_EROSION_UI * scale);
	const innerHalfWidth = halfWidth - erosionPx;
	const innerHalfHeight = halfHeight - erosionPx;
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

/**
 * The blur kernel's historical fixed size (3px) expressed as a UI-scale-
 * relative coefficient, so it derives from `scale` instead of assuming one
 * resolution. At the nominal uiScalePx of 1.77 this reproduces 3 exactly.
 */
const BLUR_KERNEL_UI = 3 / 1.77;

// Canny's thresholds operate on 8-bit gradient magnitude, not source pixels,
// so they are legitimately scale-invariant and stay fixed across resolutions.
const CANNY_THRESHOLD_LOW = 50;
const CANNY_THRESHOLD_HIGH = 150;

// Brightness (HSV value channel) thresholds shared by the rim/interior visual
// checks. These operate on 8-bit brightness, not source pixels, so they are
// legitimately scale-invariant.
/** Minimum average border (rim) brightness for both edge-loop detectors. */
const RIM_BORDER_VALUE_MIN = 145;
/** Edge-loop score's target interior brightness (rewards proximity to it). */
const EDGE_SCORE_INNER_VALUE_TARGET = 165;
/** Edge-loop score's target border brightness (rewards values above it). */
const EDGE_SCORE_BORDER_VALUE_TARGET = 150;
/** Occluded-edge-loop score's rim-brightness floor below which rimFit is 0. */
const OCCLUDED_RIM_VALUE_MIN = 120;
/** Occluded-edge-loop score's rim-brightness range over which rimFit ramps to 1. */
const OCCLUDED_RIM_VALUE_RANGE = 80;

/**
 * Gaussian-blurs `sourceMat` into `blurredMat` and runs Canny into `edgesMat`,
 * with the blur kernel size derived from `scale` (odd, minimum 3).
 */
function blurAndCanny(cv: TeePadCv, sourceMat: CvMat, blurredMat: CvMat, edgesMat: CvMat, scale: number): void {
	const kernelSize = Math.max(3, 2 * Math.round((BLUR_KERNEL_UI * scale - 1) / 2) + 1);
	const kernel = new cv.Size(kernelSize, kernelSize);
	cv.GaussianBlur(sourceMat, blurredMat, kernel, 0, 0, cv.BORDER_DEFAULT);
	cv.Canny(blurredMat, edgesMat, CANNY_THRESHOLD_LOW, CANNY_THRESHOLD_HIGH);
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

const GRAY_CENTER_DEFAULT_VALUE_MIN = 148;
const GRAY_CENTER_DEFAULT_VALUE_MAX = 168;
const GRAY_CENTER_DEFAULT_SATURATION_MAX = 18;

interface GrayCenterWindow {
	readonly valueMin: number;
	readonly valueMax: number;
	readonly saturationMax: number;
}

const GRAY_CENTER_DEFAULT_WINDOW: GrayCenterWindow = {
	valueMin: GRAY_CENTER_DEFAULT_VALUE_MIN,
	valueMax: GRAY_CENTER_DEFAULT_VALUE_MAX,
	saturationMax: GRAY_CENTER_DEFAULT_SATURATION_MAX
};

const ADAPTIVE_GRAY_CENTER_MIN_SAMPLES = 8;
const ADAPTIVE_GRAY_CENTER_VALUE_MARGIN = 6;
const ADAPTIVE_GRAY_CENTER_SATURATION_MARGIN = 3;

function sampleInteriorMedian(
	value: Uint8Array,
	saturation: Uint8Array,
	widthPx: number,
	heightPx: number,
	centerX: number,
	centerY: number,
	halfPatchPx: number
): { medianValue: number; medianSaturation: number } | undefined {
	const values: number[] = [];
	const saturations: number[] = [];
	const half = Math.max(1, Math.round(halfPatchPx));
	for (let dy = -half; dy <= half; dy += 1) {
		for (let dx = -half; dx <= half; dx += 1) {
			const x = Math.round(centerX) + dx;
			const y = Math.round(centerY) + dy;
			if (x < 0 || x >= widthPx || y < 0 || y >= heightPx) continue;
			const index = y * widthPx + x;
			values.push(value[index]);
			saturations.push(saturation[index]);
		}
	}
	if (values.length === 0) return undefined;
	values.sort((a, b) => a - b);
	saturations.sort((a, b) => a - b);
	return { medianValue: values[Math.floor(values.length / 2)], medianSaturation: saturations[Math.floor(saturations.length / 2)] };
}

/**
 * Derives a per-course gray-center brightness/saturation window from tee
 * pads the detector already found confidently (both detectors' baseline
 * candidates), instead of trusting the fixed [148,168] band alone -- tuned
 * against a rendered dev fixture, not a photographed capture. A real
 * photo's lighting varies by capture, and even hole to hole when a pad
 * sits in partial shade, so a pad whose true interior color is a
 * legitimate few units outside the fixed band is otherwise invisible to
 * gray-center regardless of contour quality. Requires at least
 * `ADAPTIVE_GRAY_CENTER_MIN_SAMPLES` baseline candidates to trust a
 * course-wide estimate; returns `undefined` otherwise.
 */
function deriveAdaptiveGrayCenterWindow(
	value: Uint8Array,
	saturation: Uint8Array,
	widthPx: number,
	heightPx: number,
	scale: number,
	baselineCandidates: readonly AnalysisCandidate[]
): GrayCenterWindow | undefined {
	if (baselineCandidates.length < ADAPTIVE_GRAY_CENTER_MIN_SAMPLES) return undefined;
	const halfPatchPx = Math.max(1, scale * 1.5);
	const values: number[] = [];
	const saturations: number[] = [];
	for (const candidate of baselineCandidates) {
		const sample = sampleInteriorMedian(value, saturation, widthPx, heightPx, candidate.x, candidate.y, halfPatchPx);
		if (sample) {
			values.push(sample.medianValue);
			saturations.push(sample.medianSaturation);
		}
	}
	if (values.length < ADAPTIVE_GRAY_CENTER_MIN_SAMPLES) return undefined;
	return {
		valueMin: Math.max(0, Math.min(...values) - ADAPTIVE_GRAY_CENTER_VALUE_MARGIN),
		valueMax: Math.min(255, Math.max(...values) + ADAPTIVE_GRAY_CENTER_VALUE_MARGIN),
		saturationMax: Math.min(255, Math.max(...saturations) + ADAPTIVE_GRAY_CENTER_SATURATION_MARGIN)
	};
}

function detectGrayCenterCandidates(
	ctx: AnalysisContext,
	maxCandidates: number,
	window: GrayCenterWindow = GRAY_CENTER_DEFAULT_WINDOW
): { candidates: AnalysisCandidate[]; stageCounts: TeePadStageCounts } {
	const { cv, raster, scale, rows, saturation, value } = ctx;
	const centerMask = new Uint8Array(value.length);
	for (let index = 0; index < centerMask.length; index += 1) {
		centerMask[index] = saturation[index] < window.saturationMax && value[index] >= window.valueMin && value[index] <= window.valueMax ? 255 : 0;
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
		blurAndCanny(cv, grayMat, blurred, edges, scale);
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
						value,
						scale
					);
					if (!visual || visual.borderValue < RIM_BORDER_VALUE_MIN) continue;
					visualAccepted += 1;
					const contrast = visual.borderValue - visual.innerValue;
					const score =
						1.5 * rectangularity -
						0.05 * Math.abs(major - 13 * scale) -
						0.05 * Math.abs(minor - 8 * scale) -
						0.018 * Math.max(0, visual.innerSaturation - 10) -
						0.015 * Math.abs(visual.innerValue - EDGE_SCORE_INNER_VALUE_TARGET) +
						0.012 * Math.max(0, visual.borderValue - EDGE_SCORE_BORDER_VALUE_TARGET) +
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

export interface WalkingPathDash {
	readonly xPx: number;
	readonly yPx: number;
	/** Undirected, normalized to [0, 180). */
	readonly orientationDeg: number;
	readonly lengthPx: number;
}

export interface WalkingPathChain {
	readonly dashes: readonly WalkingPathDash[];
	/** Undirected, normalized to [0, 180). */
	readonly orientationDeg: number;
}

/**
 * A course's walking/cart path between holes is drawn as a sequence of
 * short bright dashes -- visually similar enough to a small tee-pad
 * rectangle that a masked-template search can mistake one dash for a pad
 * (see `docs/deferred-detection-experiments.md`'s masked-NCC entry). What
 * actually distinguishes a path dash from a real, isolated pad is
 * periodicity: a path repeats at a roughly constant spacing along a
 * consistent direction, a real pad does not. This detector's whole job is
 * finding that repetition, not identifying any single dash in isolation.
 *
 * Dash geometry was measured directly off a real course image
 * (IMG_5641, the walking path near hole 3): ~17px long, ~24-25px
 * start-to-start spacing, at that image's uiScalePx of ~1.81 -- expressed
 * below as UI-scale-relative constants (dashes are a UI-drawn element, the
 * same size class as the number badge, not something that scales with map
 * zoom).
 */
const PATH_DASH_VALUE_MIN = 130;
const PATH_DASH_SATURATION_MAX = 55;
const PATH_DASH_LENGTH_UI = 9.5;
const PATH_DASH_LENGTH_TOLERANCE_UI = 4;
const PATH_DASH_PERIOD_UI = 13.6;
const PATH_DASH_PERIOD_TOLERANCE_UI = 6;
const PATH_CHAIN_ANGLE_TOLERANCE_DEG = 20;
const PATH_CHAIN_PERP_TOLERANCE_UI = 4;
/** Fewer than this is indistinguishable from an isolated rectangle -- exactly the ambiguity this detector exists to resolve. */
const PATH_MIN_CHAIN_LENGTH = 3;

interface DashCandidate {
	readonly xPx: number;
	readonly yPx: number;
	readonly orientationDeg: number;
	readonly lengthPx: number;
}

/** Two Hough detections of the same physical dash land almost on top of each other; collapse them before chaining. */
function dedupeDashes(dashes: readonly DashCandidate[], mergeRadiusPx: number): DashCandidate[] {
	const kept: DashCandidate[] = [];
	for (const dash of dashes) {
		if (kept.some((existing) => Math.hypot(existing.xPx - dash.xPx, existing.yPx - dash.yPx) <= mergeRadiusPx)) continue;
		kept.push(dash);
	}
	return kept;
}

function chainDashSegments(rawDashes: readonly DashCandidate[], scale: number): WalkingPathChain[] {
	const dashes = dedupeDashes(rawDashes, PATH_DASH_LENGTH_UI * 0.5 * scale);
	const periodMin = (PATH_DASH_PERIOD_UI - PATH_DASH_PERIOD_TOLERANCE_UI) * scale;
	const periodMax = (PATH_DASH_PERIOD_UI + PATH_DASH_PERIOD_TOLERANCE_UI) * scale;
	const perpTolerance = PATH_CHAIN_PERP_TOLERANCE_UI * scale;

	const parent = dashes.map((_, index) => index);
	function find(index: number): number {
		while (parent[index] !== index) {
			parent[index] = parent[parent[index]];
			index = parent[index];
		}
		return index;
	}
	function union(a: number, b: number): void {
		const rootA = find(a);
		const rootB = find(b);
		if (rootA !== rootB) parent[rootA] = rootB;
	}

	for (let i = 0; i < dashes.length; i += 1) {
		for (let j = i + 1; j < dashes.length; j += 1) {
			const a = dashes[i];
			const b = dashes[j];
			const angleDelta = Math.abs(a.orientationDeg - b.orientationDeg);
			if (Math.min(angleDelta, 180 - angleDelta) > PATH_CHAIN_ANGLE_TOLERANCE_DEG) continue;
			const dx = b.xPx - a.xPx;
			const dy = b.yPx - a.yPx;
			const distance = Math.hypot(dx, dy);
			// Up to ~1.6 periods tolerates one missed detection between real dashes without inviting an unrelated pair in.
			if (distance < periodMin * 0.7 || distance > periodMax * 1.6) continue;
			const radians = (circularMeanOrientationDeg([a.orientationDeg, b.orientationDeg]) * Math.PI) / 180;
			const perpendicular = Math.abs(-Math.sin(radians) * dx + Math.cos(radians) * dy);
			if (perpendicular > perpTolerance) continue;
			union(i, j);
		}
	}

	const groups = new Map<number, DashCandidate[]>();
	dashes.forEach((dash, index) => {
		const root = find(index);
		const group = groups.get(root);
		if (group) group.push(dash);
		else groups.set(root, [dash]);
	});

	const chains: WalkingPathChain[] = [];
	for (const group of groups.values()) {
		if (group.length < PATH_MIN_CHAIN_LENGTH) continue;
		chains.push({
			dashes: group.map((dash) => ({ ...dash })),
			orientationDeg: circularMeanOrientationDeg(group.map((dash) => dash.orientationDeg))
		});
	}
	return chains;
}

/**
 * Finds dashed walking/cart path chains within the map area. Never a target
 * of its own detection budget -- callers use the result two ways: (1) as
 * exclusion regions (`deriveWalkingPathMasksPx`) so a tee-pad search
 * doesn't mistake one dash for a pad, and (2) potentially as a positional
 * signal, since a path's terminus tends to sit right at a tee or basket
 * (course routing walks from one green to the next tee) -- not yet used for
 * that second purpose by any caller.
 */
export function detectDashedPathChains(
	cv: TeePadCv,
	raster: TeePadRaster,
	options: TeePadDetectionOptions
): readonly WalkingPathChain[] {
	validateInputs(raster, options);
	const rows = mapRows(raster, options.mapBoundsPx);
	if (!rows) return [];
	const { saturation, value } = readHsv(raster);
	const scale = options.uiScalePx / raster.sourceScale;
	const bright = new Uint8Array(value.length);
	for (let index = 0; index < bright.length; index += 1) {
		bright[index] =
			value[index] >= PATH_DASH_VALUE_MIN && saturation[index] <= PATH_DASH_SATURATION_MAX ? 255 : 0;
	}
	insideRows(bright, raster.widthPx, rows);

	const brightMat = matFromBytes(cv, bright, raster.widthPx, raster.heightPx);
	const lines = new cv.Mat();
	try {
		const expectedLength = PATH_DASH_LENGTH_UI * scale;
		const lengthTolerance = PATH_DASH_LENGTH_TOLERANCE_UI * scale;
		cv.HoughLinesP(
			brightMat,
			lines,
			1,
			Math.PI / 180,
			4,
			Math.max(3, expectedLength - lengthTolerance),
			Math.max(2, expectedLength * 0.3)
		);
		const rawDashes: DashCandidate[] = houghSegments(lines)
			.filter((segment) => {
				const length = segmentLength(segment);
				return length >= expectedLength - lengthTolerance && length <= expectedLength + lengthTolerance;
			})
			.map((segment) => ({
				xPx: (segment.x1 + segment.x2) / 2,
				yPx: (segment.y1 + segment.y2) / 2,
				orientationDeg: segmentAngle(segment),
				lengthPx: segmentLength(segment)
			}));
		return chainDashSegments(rawDashes, scale);
	} finally {
		brightMat.delete();
		lines.delete();
	}
}

/** One small circle per dash -- just enough to cover it, not the gaps between (those are already background, nothing to mask). */
export function deriveWalkingPathMasksPx(
	chains: readonly WalkingPathChain[],
	uiScalePx: number
): NonNullable<TeePadDetectionOptions['ignoreCirclesPx']> {
	const radiusPx = PATH_DASH_LENGTH_UI * 0.75 * uiScalePx;
	return chains.flatMap((chain) => chain.dashes.map((dash) => ({ xPx: dash.xPx, yPx: dash.yPx, radiusPx })));
}

export interface PuttingCircleFit {
	/** Source-image pixels. */
	readonly radiusPx: number;
	/** Fraction of the fitted ring's circumference that landed on bright-dash evidence. */
	readonly coverage: number;
}

export interface PuttingCircleSourceBasket {
	readonly xPx: number;
	readonly yPx: number;
	readonly score: number;
}

const PUTTING_CIRCLE_BRIGHT_VALUE_MIN = 210;
const PUTTING_CIRCLE_BRIGHT_SATURATION_MAX = 40;
const PUTTING_CIRCLE_MIN_RADIUS_UI = 8;
const PUTTING_CIRCLE_MAX_RADIUS_UI = 60;
const PUTTING_CIRCLE_RADIUS_STEP_UI = 0.5;
const PUTTING_CIRCLE_MIN_COVERAGE = 0.15;
const PUTTING_CIRCLE_MAX_COVERAGE = 0.75;
/**
 * Genuine dashes hit the ring in many short, roughly evenly-spaced arcs. A
 * real rectangle edge (a tee pad's own rail, a walking path) crossing the
 * sweep circle only touches it at one or two localized points, however long
 * the arc there is -- so a minimum *run count*, not just coverage fraction,
 * is what actually distinguishes "dashed ring" from "a straight edge happens
 * to cross this circle." Without this gate the sweep can lock onto a real
 * pad's own edge and mask it away as if it were dash evidence.
 */
const PUTTING_CIRCLE_MIN_RUNS = 5;
const PUTTING_CIRCLE_MIN_BASKET_SCORE = 0.7;
/** UI-scale multiple: dash stroke width is UI-drawn, not map-scaled, so uiScalePx (not a real-world unit) is the right unit for it. */
export const PUTTING_CIRCLE_RING_HALF_THICKNESS_UI = 2.5;

/**
 * Fits the radius of a dashed putting-circle drawn around a basket by
 * sweeping candidate radii outward from the basket and keeping the one whose
 * ring has the strongest bright-dash evidence.
 *
 * There is deliberately no fixed real-world-to-pixel conversion here: unlike
 * a number badge (drawn at a fixed on-screen size regardless of map zoom),
 * a putting circle is drawn to the *map's* scale, which varies per
 * screenshot. A radius derived from a real-world distance constant would
 * only be correct for whatever zoom level it was measured against, so the
 * radius has to be measured from each image instead.
 */
export function fitPuttingCircleRadiusPx(
	raster: TeePadRaster,
	centerXPx: number,
	centerYPx: number,
	uiScalePx: number
): PuttingCircleFit | null {
	const { saturation, value } = readHsv(raster);
	const width = raster.widthPx;
	const height = raster.heightPx;
	const bright = new Uint8Array(value.length);
	for (let index = 0; index < bright.length; index += 1) {
		bright[index] =
			value[index] >= PUTTING_CIRCLE_BRIGHT_VALUE_MIN &&
			saturation[index] <= PUTTING_CIRCLE_BRIGHT_SATURATION_MAX
				? 255
				: 0;
	}
	const scale = uiScalePx / raster.sourceScale;
	const centerX = centerXPx / raster.sourceScale;
	const centerY = centerYPx / raster.sourceScale;
	const sampleRadius = Math.max(1, Math.round(scale * 0.6));
	let best: PuttingCircleFit | null = null;
	for (
		let radiusUi = PUTTING_CIRCLE_MIN_RADIUS_UI;
		radiusUi <= PUTTING_CIRCLE_MAX_RADIUS_UI;
		radiusUi += PUTTING_CIRCLE_RADIUS_STEP_UI
	) {
		const radius = radiusUi * scale;
		if (centerX - radius < 0 || centerX + radius >= width || centerY - radius < 0 || centerY + radius >= height) {
			continue;
		}
		const samples = Math.max(24, Math.ceil(radius * 0.5));
		const hits = new Array<boolean>(samples);
		let hitCount = 0;
		for (let sample = 0; sample < samples; sample += 1) {
			const angle = (sample / samples) * Math.PI * 2;
			const x = Math.round(centerX + radius * Math.cos(angle));
			const y = Math.round(centerY + radius * Math.sin(angle));
			let found = false;
			for (let dy = -sampleRadius; dy <= sampleRadius && !found; dy += 1) {
				for (let dx = -sampleRadius; dx <= sampleRadius; dx += 1) {
					const nearbyX = x + dx;
					const nearbyY = y + dy;
					if (nearbyX < 0 || nearbyX >= width || nearbyY < 0 || nearbyY >= height) continue;
					if (bright[nearbyY * width + nearbyX] !== 0) {
						found = true;
						break;
					}
				}
			}
			hits[sample] = found;
			if (found) hitCount += 1;
		}
		const coverage = hitCount / samples;
		let runs = 0;
		for (let sample = 0; sample < samples; sample += 1) {
			if (hits[sample] && !hits[(sample - 1 + samples) % samples]) runs += 1;
		}
		if (runs === 0 && hitCount === samples) runs = 1;
		if (runs < PUTTING_CIRCLE_MIN_RUNS) continue;
		if (coverage > PUTTING_CIRCLE_MAX_COVERAGE) continue;
		if (!best || coverage > best.coverage) best = { radiusPx: radius * raster.sourceScale, coverage };
	}
	if (!best || best.coverage < PUTTING_CIRCLE_MIN_COVERAGE) return null;
	return best;
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * Derives `ignoreCirclesPx` entries for every confidently-detected basket, so
 * a neighboring hole's dashed putting circle can be masked out of the
 * occluded-edge-loop tee search before it breaks a real pad's outline. Only
 * baskets whose own detector score already clears a high floor are used --
 * a shaky basket guess should not go on to erase real evidence elsewhere.
 *
 * The radius is fit per basket, but pooled across baskets before use: a
 * putting circle is drawn at one constant scale throughout a single image
 * (only the scale *between* different screenshots varies, per this module's
 * calibration notes elsewhere), so a basket whose own dash is too faint,
 * cropped, or occluded to fit alone can still be masked correctly using the
 * radius measured from a cleaner dash elsewhere on the same course.
 */
export function derivePuttingCircleMasksPx(
	raster: TeePadRaster,
	baskets: readonly PuttingCircleSourceBasket[],
	uiScalePx: number
): NonNullable<TeePadDetectionOptions['ignoreCirclesPx']> {
	const confident = baskets.filter((basket) => basket.score >= PUTTING_CIRCLE_MIN_BASKET_SCORE);
	const fits = confident
		.map((basket) => fitPuttingCircleRadiusPx(raster, basket.xPx, basket.yPx, uiScalePx))
		.filter((fit): fit is PuttingCircleFit => fit !== null);
	if (fits.length === 0) return [];
	const sharedRadiusPx = median(fits.map((fit) => fit.radiusPx));
	const halfThicknessPx = PUTTING_CIRCLE_RING_HALF_THICKNESS_UI * uiScalePx;
	return confident.map((basket) => ({
		xPx: basket.xPx,
		yPx: basket.yPx,
		radiusPx: sharedRadiusPx + halfThicknessPx,
		innerRadiusPx: Math.max(0, sharedRadiusPx - halfThicknessPx)
	}));
}

/**
 * Basket coordinates are the icon's stem/base (see this module's callers),
 * but the icon graphic itself is drawn almost entirely *above* that point --
 * a tall pin/chain-basket shape, not a symbol centered on its own anchor.
 * Measured directly off a real course image (Alex Clark, hole 8's basket):
 * the icon's visible top sits roughly 20 uiScalePx units above the anchor,
 * with a half-width around 22 units -- a plain disc centered on the anchor
 * would need to be that large in every direction just to reach the top,
 * wasting most of its coverage on the mostly-empty space below and beside
 * the stem where a neighboring hole's real tee-pad evidence is more likely
 * to actually be. An offset disc, shifted up toward the icon's vertical
 * center, covers the same icon with a smaller radius and less collateral
 * masking.
 *
 * Unlike the putting circle (map-scale, fit per image), the icon is a
 * UI-drawn element at a fixed size relative to uiScalePx, the same way the
 * number badge is -- no per-image fitting needed.
 */
const BASKET_ICON_MASK_VERTICAL_OFFSET_UI = 20;
const BASKET_ICON_MASK_RADIUS_UI = 28;
const BASKET_ICON_MIN_SCORE = 0.7;

export function deriveBasketIconMasksPx(
	baskets: readonly PuttingCircleSourceBasket[],
	uiScalePx: number
): NonNullable<TeePadDetectionOptions['ignoreCirclesPx']> {
	const offsetPx = BASKET_ICON_MASK_VERTICAL_OFFSET_UI * uiScalePx;
	const radiusPx = BASKET_ICON_MASK_RADIUS_UI * uiScalePx;
	return baskets
		.filter((basket) => basket.score >= BASKET_ICON_MIN_SCORE)
		.map((basket) => ({
			xPx: basket.xPx,
			yPx: basket.yPx - offsetPx,
			radiusPx
		}));
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
		const innerRadius = Math.max(0, (circle.innerRadiusPx ?? 0) / sourceScale);
		if (!Number.isFinite(centerX) || !Number.isFinite(centerY) || !Number.isFinite(radius) || radius <= 0) continue;
		const radiusSquared = radius * radius;
		const innerRadiusSquared = innerRadius * innerRadius;
		const firstX = clamp(Math.floor(centerX - radius), 0, width - 1);
		const lastX = clamp(Math.ceil(centerX + radius), 0, width - 1);
		const firstY = clamp(Math.floor(centerY - radius), 0, height - 1);
		const lastY = clamp(Math.ceil(centerY + radius), 0, height - 1);
		for (let y = firstY; y <= lastY; y += 1) {
			for (let x = firstX; x <= lastX; x += 1) {
				const dx = x - centerX;
				const dy = y - centerY;
				const distanceSquared = dx * dx + dy * dy;
				if (distanceSquared <= radiusSquared && distanceSquared >= innerRadiusSquared) {
					edges[y * width + x] = 0;
				}
			}
		}
	}
	return circles.length;
}

/**
 * Occluded-edge-loop rail-pairing geometry, expressed as UI-scale-relative
 * coefficients (`K_UI = historical_value / 1.77`) instead of raw source-pixel
 * constants divided only by `sourceScale`. Multiplying each by the detector's
 * local `scale = uiScalePx / sourceScale` reproduces the exact historically
 * tuned values at the nominal uiScalePx of 1.77, while scaling correctly with
 * the UI icon scale at other resolutions -- matching the gray-center and
 * edge-loop detectors, which already key their geometry off `scale`. All of
 * these encode the same ~13x8 UI-px pad envelope (a tee pad's two occluded
 * rails, each up to ~20px long, separated by ~5-8.5px) that the other
 * detectors target directly.
 */
const OCCLUDED_MIN_SEGMENT_LENGTH_UI = 5 / 1.77;
const OCCLUDED_MAJOR_MIN_UI = 16 / 1.77;
const OCCLUDED_MAJOR_MAX_UI = 20 / 1.77;
const OCCLUDED_SEPARATION_MIN_UI = 5 / 1.77;
const OCCLUDED_SEPARATION_MAX_UI = 8.5 / 1.77;
/** occludedPairScore's target/tolerance pair for the rail-pair major axis. */
const OCCLUDED_SCORE_MAJOR_TARGET_UI = 18 / 1.77;
const OCCLUDED_SCORE_MAJOR_TOLERANCE_UI = 2 / 1.77;
/** occludedPairScore's target/tolerance pair for rail separation (minor axis). */
const OCCLUDED_SCORE_SEPARATION_TARGET_UI = 6.75 / 1.77;
const OCCLUDED_SCORE_SEPARATION_TOLERANCE_UI = 1.75 / 1.77;
/** HoughLinesP's minLineLength/maxLineGap for occluded-edge-loop's rail search. */
const OCCLUDED_HOUGH_MIN_LINE_LENGTH_UI = 5 / 1.77;
const OCCLUDED_HOUGH_MAX_LINE_GAP_UI = 6 / 1.77;
const OCCLUDED_MAX_SEGMENT_LENGTH_UI = 20 / 1.77;
const OCCLUDED_MAX_PAIR_DISTANCE_UI = 24 / 1.77;

function occludedPair(
	first: HoughSegment,
	second: HoughSegment,
	scale: number
): OccludedPair | null {
	const firstLength = segmentLength(first);
	const secondLength = segmentLength(second);
	const minimumSegmentLength = OCCLUDED_MIN_SEGMENT_LENGTH_UI * scale;
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
	const majorMinimum = OCCLUDED_MAJOR_MIN_UI * scale;
	const majorMaximum = OCCLUDED_MAJOR_MAX_UI * scale;
	if (major < majorMinimum || major > majorMaximum) return null;

	const firstMidpoint = { x: (first.x1 + first.x2) * 0.5, y: (first.y1 + first.y2) * 0.5 };
	const secondMidpoint = { x: (second.x1 + second.x2) * 0.5, y: (second.y1 + second.y2) * 0.5 };
	const separation = Math.abs(
		(secondMidpoint.x - firstMidpoint.x) * nx + (secondMidpoint.y - firstMidpoint.y) * ny
	);
	const separationMinimum = OCCLUDED_SEPARATION_MIN_UI * scale;
	const separationMaximum = OCCLUDED_SEPARATION_MAX_UI * scale;
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

function occludedPairScore(pair: OccludedPair, visual: VisualStats, scale: number): number {
	const lengthFit = clamp(
		1 - Math.abs(pair.major - OCCLUDED_SCORE_MAJOR_TARGET_UI * scale) / (OCCLUDED_SCORE_MAJOR_TOLERANCE_UI * scale),
		0,
		1
	);
	const separationFit = clamp(
		1 -
			Math.abs(pair.minor - OCCLUDED_SCORE_SEPARATION_TARGET_UI * scale) /
				(OCCLUDED_SCORE_SEPARATION_TOLERANCE_UI * scale),
		0,
		1
	);
	const parallelFit = clamp(1 - pair.angleDeltaDeg / 10, 0, 1);
	const overlapFit = clamp(pair.overlap / Math.min(pair.firstLength, pair.secondLength), 0, 1);
	const rimFit = clamp((visual.borderValue - OCCLUDED_RIM_VALUE_MIN) / OCCLUDED_RIM_VALUE_RANGE, 0, 1);
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
	const scale = options.uiScalePx / raster.sourceScale;
	const grayMat = matFromBytes(cv, gray, raster.widthPx, raster.heightPx);
	const blurred = new cv.Mat();
	const edges = new cv.Mat();
	const lines = new cv.Mat();
	try {
		blurAndCanny(cv, grayMat, blurred, edges, scale);
		insideRows(edges.data, raster.widthPx, rows);
		const masked = maskIgnoredCircles(
			edges.data,
			raster.widthPx,
			raster.heightPx,
			raster.sourceScale,
			options.ignoreCirclesPx
		);

		cv.HoughLinesP(
			edges,
			lines,
			1,
			Math.PI / 180,
			8, // vote count, not a pixel length -- scale-invariant, stays fixed.
			OCCLUDED_HOUGH_MIN_LINE_LENGTH_UI * scale,
			OCCLUDED_HOUGH_MAX_LINE_GAP_UI * scale
		);
		const discoveredSegments = houghSegments(lines);
		const minimumSegmentLength = OCCLUDED_MIN_SEGMENT_LENGTH_UI * scale;
		const maximumSegmentLength = OCCLUDED_MAX_SEGMENT_LENGTH_UI * scale;
		const segments = discoveredSegments.filter((segment) => {
			const length = segmentLength(segment);
			return length >= minimumSegmentLength && length <= maximumSegmentLength;
		});
		const maximumPairDistance = OCCLUDED_MAX_PAIR_DISTANCE_UI * scale;
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
							const pair = occludedPair(first, second, scale);
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
								value,
								scale
							);
							if (!visual || visual.borderValue < RIM_BORDER_VALUE_MIN) continue;
							visualCount += 1;
							candidates.push({
								x: pair.centerX,
								y: pair.centerY,
								orientationDeg: pair.angleDeg,
								width: pair.major,
								height: pair.minor,
								score: occludedPairScore(pair, visual, scale),
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
			if (kept.some((existing) => tooClose(candidate, existing, 7 * options.uiScalePx / raster.sourceScale))) continue;
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

	// A pad whose true interior brightness is a legitimate few units outside
	// the fixed [148,168] band (real-photo lighting/shade, not present on the
	// rendered dev fixture the band was tuned against) is otherwise invisible
	// to gray-center no matter its contour quality. Re-run with a window
	// derived from pads already found confidently, keeping only candidates
	// with no existing nearby detection -- a gap filler, never a competitor.
	const baseline = [...detectorA, ...detectorB];
	const adaptiveWindow = deriveAdaptiveGrayCenterWindow(value, saturation, raster.widthPx, raster.heightPx, scale, baseline);
	const detectorAGapFillers = adaptiveWindow
		? detectGrayCenterCandidates(ctx, Infinity, adaptiveWindow).candidates.filter(
				(candidate) => !baseline.some((existing) => tooClose(candidate, existing, 7 * scale))
			)
		: [];

	const fused = fuseCandidates([...detectorA, ...detectorAGapFillers, ...detectorB], [], raster, options.uiScalePx);
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
			const baseline = [...detectorA, ...detectorB];
			const adaptiveWindow = deriveAdaptiveGrayCenterWindow(value, saturation, raster.widthPx, raster.heightPx, scale, baseline);
			const detectorAGapFillers = adaptiveWindow
				? detectGrayCenterCandidates(ctx, Infinity, adaptiveWindow).candidates.filter(
						(candidate) => !baseline.some((existing) => tooClose(candidate, existing, 7 * scale))
					)
				: [];
			const fused = fuseCandidates([...detectorA, ...detectorAGapFillers, ...detectorB], [], raster, options.uiScalePx);
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
