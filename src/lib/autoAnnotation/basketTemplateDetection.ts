/**
 * Basket proposal detection for the clean UDisc-style course map fixture.
 *
 * A direct port of the proven CV probe's `detect_baskets`
 * (`scripts/cv-probes/static_course_parser.py`): multiscale template match
 * against the canonical basket glyph (`static/resources/chainspot_cv_templates/basket.png`),
 * scaled relative to the same `uiScalePx` the number-badge/tee-pad detectors
 * already derive — not a fixed, image-scale-independent ladder.
 *
 * Unlike tee pads, baskets always render upright and unrotated, so template
 * matching (not geometric detection) is the right tool here; the previous
 * production implementation's underperformance traced to using the wrong
 * template asset and calibration, not to the shape being hard to match.
 *
 * This is intentionally worker-only-adjacent but environment-agnostic code:
 * the caller supplies an already-decoded grayscale raster and the OpenCV
 * instance it owns. It does not load WASM, decode images, or mutate editor
 * state, so it runs identically in a browser worker or a Node CLI.
 */

export interface BasketRaster {
	readonly gray: Uint8Array;
	readonly widthPx: number;
	readonly heightPx: number;
	/** Source pixels per raster pixel: 1 for full resolution, >1 after a downsample. */
	readonly sourceScale: number;
}

export interface BasketTemplateRaster {
	readonly gray: Uint8Array;
	readonly widthPx: number;
	readonly heightPx: number;
}

export interface BasketCandidate {
	/** Semantic endpoint: the bottom-center stem base, not the glyph/icon center. */
	readonly xPx: number;
	readonly yPx: number;
	readonly score: number;
	readonly widthPx: number;
	readonly heightPx: number;
	/** The uiScalePx-relative template scale this candidate matched at. */
	readonly scale: number;
}

export interface BasketDetectionOptions {
	/** Source-image pixels per UI icon scale, as derived by the number-badge detector. */
	readonly uiScalePx: number;
	/** Optional source-image vertical map extent. Everything outside is ignored. */
	readonly mapBoundsPx?: Readonly<{ topPx: number; bottomPx: number }>;
	/** Keep at most this many candidates. Defaults to the 18-hole MVP. */
	readonly maxCandidates?: number;
	/** Minimum normalized cross-correlation score. Defaults to the proven probe's 0.50. */
	readonly minScore?: number;
}

type CvMat = {
	readonly rows: number;
	readonly cols: number;
	readonly data: Uint8Array;
	readonly data32F?: Float32Array;
	delete(): void;
};

type CvSize = unknown;

/** Narrow OpenCV surface used by this detector. */
export interface BasketCv {
	Mat: new (rows?: number, cols?: number, type?: number) => CvMat;
	Size: new (width: number, height: number) => CvSize;
	CV_8UC1: number;
	TM_CCOEFF_NORMED: number;
	INTER_AREA: number;
	INTER_CUBIC: number;
	matchTemplate(image: CvMat, templ: CvMat, result: CvMat, method: number): void;
	resize(source: CvMat, destination: CvMat, size: CvSize, fx: number, fy: number, interpolation: number): void;
	minMaxLoc(source: CvMat): {
		minVal: number;
		maxVal: number;
		minLoc: { x: number; y: number };
		maxLoc: { x: number; y: number };
	};
}

/** Matches the proven probe's `linspace(uiScale*.90, uiScale*1.10, 9)`. */
const SCALE_SAMPLE_COUNT = 9;
const SCALE_RANGE_LOW = 0.9;
const SCALE_RANGE_HIGH = 1.1;
const DEFAULT_MIN_SCORE = 0.5;
const DEFAULT_MAX_CANDIDATES = 18;
/** Matches the proven probe's basket semantic endpoint: bottom-center stem base. */
const BASKET_BASE_Y_FRACTION = 0.96;
/** Local-maxima suppression window radius, matching the probe's 11x11 dilation kernel. */
const LOCAL_MAXIMUM_RADIUS = 5;

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.max(minimum, Math.min(maximum, value));
}

function scaleSamples(uiScalePx: number): number[] {
	const samples: number[] = [];
	for (let index = 0; index < SCALE_SAMPLE_COUNT; index += 1) {
		const fraction = index / (SCALE_SAMPLE_COUNT - 1);
		samples.push(uiScalePx * (SCALE_RANGE_LOW + fraction * (SCALE_RANGE_HIGH - SCALE_RANGE_LOW)));
	}
	return samples;
}

function matFromBytes(cv: BasketCv, bytes: Uint8Array, width: number, height: number): CvMat {
	const mat = new cv.Mat(height, width, cv.CV_8UC1);
	mat.data.set(bytes);
	return mat;
}

function resizeTemplate(cv: BasketCv, template: BasketTemplateRaster, scale: number): CvMat {
	const width = Math.max(5, Math.round(template.widthPx * scale));
	const height = Math.max(5, Math.round(template.heightPx * scale));
	const source = matFromBytes(cv, template.gray, template.widthPx, template.heightPx);
	const destination = new cv.Mat();
	try {
		cv.resize(
			source,
			destination,
			new cv.Size(width, height),
			0,
			0,
			scale < 1 ? cv.INTER_AREA : cv.INTER_CUBIC
		);
	} finally {
		source.delete();
	}
	return destination;
}

export interface BasketAnchorScale {
	readonly scale: number;
	readonly score: number;
}

export interface FindBasketAnchorScaleOptions {
	/** Coarse blind sweep bounds, as a multiple of the template's own canonical size. Defaults to 0.4..4.0. */
	readonly scaleRangeLow?: number;
	readonly scaleRangeHigh?: number;
	/** Coarse sweep step size. Defaults to 0.15. A finer refinement pass always follows around the coarse winner. */
	readonly scaleStep?: number;
	/** Skip the refinement pass (used by tests exercising the coarse sweep alone). Defaults to true. */
	readonly refine?: boolean;
}

const DEFAULT_ANCHOR_SCALE_RANGE_LOW = 0.4;
const DEFAULT_ANCHOR_SCALE_RANGE_HIGH = 4.0;
/**
 * A full 0.4..4.0 sweep at the previous 0.05 step was ~72 full-image
 * matchTemplate passes -- fine for an offline CLI investigation, too slow to
 * run on every load in a production worker. The coarse pass now uses a much
 * bigger step, and a refinement pass (see `refineScale`) narrows around the
 * coarse winner at fine precision, so overall accuracy is unchanged while
 * total passes drop by roughly half.
 */
const DEFAULT_ANCHOR_SCALE_STEP = 0.15;
const REFINE_STEP_DIVISOR = 15;

function sweepScales(
	cv: BasketCv,
	image: CvMat,
	template: BasketTemplateRaster,
	raster: BasketRaster,
	low: number,
	high: number,
	step: number
): BasketAnchorScale | null {
	let best: BasketAnchorScale | null = null;
	for (let scale = low; scale <= high + 1e-9; scale += step) {
		const resized = resizeTemplate(cv, template, scale);
		try {
			if (resized.cols >= raster.widthPx || resized.rows >= raster.heightPx) continue;
			const result = new cv.Mat();
			try {
				cv.matchTemplate(image, resized, result, cv.TM_CCOEFF_NORMED);
				const { maxVal } = cv.minMaxLoc(result);
				if (!best || maxVal > best.score) best = { scale, score: maxVal };
			} finally {
				result.delete();
			}
		} finally {
			resized.delete();
		}
	}
	return best;
}

/**
 * Finds the single template scale (as a multiple of the canonical basket
 * template's own pixel size) whose best match anywhere in the raster scores
 * highest, via a broad blind sweep — the same strategy the proven probe uses
 * to derive its number-badge UI scale from scratch (`ui_scale_from_hole_one`).
 *
 * This deliberately does NOT assume a basket icon is rendered at the same
 * scale as the number badge relative to their own canonical templates: that
 * ratio holds when both are drawn by the same UI (UDisc's own course-editor
 * screenshot, which is what `uiScalePx` is calibrated against), but does not
 * hold for a differently-styled course capture (e.g. a satellite/map photo
 * with custom pin-style markers), where a basket icon can be a very
 * different multiple of its canonical template's size than a number badge is
 * of its own. Measured on one such real fixture, the basket icon's true
 * scale was roughly 2x what the number-badge-derived `uiScalePx` predicted —
 * enough to push every candidate below the match-score floor.
 *
 * Runs coarse-to-fine: a wide coarse sweep, then a narrow high-precision
 * refinement pass around the coarse winner (see `DEFAULT_ANCHOR_SCALE_STEP`).
 */
export function findBasketAnchorScale(
	cv: BasketCv,
	raster: BasketRaster,
	template: BasketTemplateRaster,
	options: FindBasketAnchorScaleOptions = {}
): BasketAnchorScale | null {
	const scaleRangeLow = options.scaleRangeLow ?? DEFAULT_ANCHOR_SCALE_RANGE_LOW;
	const scaleRangeHigh = options.scaleRangeHigh ?? DEFAULT_ANCHOR_SCALE_RANGE_HIGH;
	const scaleStep = options.scaleStep ?? DEFAULT_ANCHOR_SCALE_STEP;
	const refine = options.refine ?? true;
	if (!(scaleRangeHigh > scaleRangeLow) || !(scaleStep > 0)) {
		throw new Error('findBasketAnchorScale requires scaleRangeHigh > scaleRangeLow and a positive scaleStep.');
	}

	const image = matFromBytes(cv, raster.gray, raster.widthPx, raster.heightPx);
	try {
		const coarse = sweepScales(cv, image, template, raster, scaleRangeLow, scaleRangeHigh, scaleStep);
		if (!coarse || !refine) return coarse;
		const fineStep = scaleStep / REFINE_STEP_DIVISOR;
		const fineLow = Math.max(scaleRangeLow, coarse.scale - scaleStep);
		const fineHigh = Math.min(scaleRangeHigh, coarse.scale + scaleStep);
		const fine = sweepScales(cv, image, template, raster, fineLow, fineHigh, fineStep);
		return fine && fine.score >= coarse.score ? fine : coarse;
	} finally {
		image.delete();
	}
}

function mapRows(
	raster: BasketRaster,
	mapBoundsPx: BasketDetectionOptions['mapBoundsPx']
): { first: number; last: number } | null {
	if (!mapBoundsPx) return { first: 0, last: raster.heightPx - 1 };
	const first = clamp(Math.ceil(mapBoundsPx.topPx / raster.sourceScale), 0, raster.heightPx - 1);
	const last = clamp(Math.floor(mapBoundsPx.bottomPx / raster.sourceScale), 0, raster.heightPx - 1);
	return first <= last ? { first, last } : null;
}

interface RawHit {
	readonly x: number;
	readonly y: number;
	readonly score: number;
	readonly templateWidth: number;
	readonly templateHeight: number;
	readonly scale: number;
}

/**
 * Collects response-map local maxima above `minScore`, using an
 * `(2*LOCAL_MAXIMUM_RADIUS+1)`-square neighborhood — matching the proven
 * probe's `cv2.dilate(response, np.ones((11, 11)))` step. A tighter window
 * lets many near-duplicate noisy peaks through per scale, which can crowd
 * real detections out of a bounded top-N slice downstream.
 */
function collectLocalMaxima(
	result: CvMat,
	templateWidth: number,
	templateHeight: number,
	scale: number,
	minScore: number
): RawHit[] {
	const values = result.data32F ?? (result.data as unknown as Float32Array);
	const hits: RawHit[] = [];
	for (let y = 0; y < result.rows; y += 1) {
		for (let x = 0; x < result.cols; x += 1) {
			const score = values[y * result.cols + x];
			if (score < minScore) continue;
			let isLocalMaximum = true;
			for (let dy = -LOCAL_MAXIMUM_RADIUS; dy <= LOCAL_MAXIMUM_RADIUS && isLocalMaximum; dy += 1) {
				const neighborY = y + dy;
				if (neighborY < 0 || neighborY >= result.rows) continue;
				for (let dx = -LOCAL_MAXIMUM_RADIUS; dx <= LOCAL_MAXIMUM_RADIUS; dx += 1) {
					if (dx === 0 && dy === 0) continue;
					const neighborX = x + dx;
					if (neighborX < 0 || neighborX >= result.cols) continue;
					if (values[neighborY * result.cols + neighborX] > score) {
						isLocalMaximum = false;
						break;
					}
				}
			}
			if (isLocalMaximum) hits.push({ x, y, score, templateWidth, templateHeight, scale });
		}
	}
	return hits;
}

function validateInputs(raster: BasketRaster, template: BasketTemplateRaster, options: BasketDetectionOptions): void {
	if (!Number.isInteger(raster.widthPx) || !Number.isInteger(raster.heightPx) || raster.widthPx <= 0 || raster.heightPx <= 0) {
		throw new Error('Basket detection received invalid raster dimensions.');
	}
	if (!Number.isFinite(raster.sourceScale) || raster.sourceScale <= 0) {
		throw new Error('Basket detection requires a positive sourceScale.');
	}
	if (raster.gray.length < raster.widthPx * raster.heightPx) {
		throw new Error('Basket detection raster does not contain grayscale pixels for its dimensions.');
	}
	if (!Number.isInteger(template.widthPx) || !Number.isInteger(template.heightPx) || template.widthPx <= 0 || template.heightPx <= 0) {
		throw new Error('Basket detection received an invalid template raster.');
	}
	if (!Number.isFinite(options.uiScalePx) || options.uiScalePx <= 0) {
		throw new Error('Basket detection requires a positive uiScalePx.');
	}
}

/**
 * Detect basket proposals from a grayscale raster. The caller owns every Mat
 * passed through `cv`; this function frees all temporary Mats before it
 * returns or throws.
 */
export function detectBasketTemplateCandidates(
	cv: BasketCv,
	raster: BasketRaster,
	template: BasketTemplateRaster,
	options: BasketDetectionOptions
): readonly BasketCandidate[] {
	validateInputs(raster, template, options);
	const rows = mapRows(raster, options.mapBoundsPx);
	if (!rows) return [];
	const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
	const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
	if (!Number.isInteger(maxCandidates) || maxCandidates < 1) {
		throw new Error('Basket detection maxCandidates must be a positive integer.');
	}

	const scale = options.uiScalePx / raster.sourceScale;
	const image = matFromBytes(cv, raster.gray, raster.widthPx, raster.heightPx);
	const hits: RawHit[] = [];
	try {
		for (const templateScale of scaleSamples(scale)) {
			const resized = resizeTemplate(cv, template, templateScale);
			try {
				if (resized.cols >= raster.widthPx || resized.rows >= raster.heightPx) continue;
				const result = new cv.Mat();
				try {
					cv.matchTemplate(image, resized, result, cv.TM_CCOEFF_NORMED);
					hits.push(...collectLocalMaxima(result, resized.cols, resized.rows, templateScale, minScore));
				} finally {
					result.delete();
				}
			} finally {
				resized.delete();
			}
		}
	} finally {
		image.delete();
	}

	hits.sort((a, b) => b.score - a.score);
	const nmsRadius = Math.max(16, 22 * scale);
	const nmsRadiusSquared = nmsRadius * nmsRadius;
	const kept: RawHit[] = [];
	for (const hit of hits) {
		const centerX = hit.x + hit.templateWidth / 2;
		const centerY = hit.y + hit.templateHeight * BASKET_BASE_Y_FRACTION;
		if (centerY < rows.first || centerY > rows.last) continue;
		const tooClose = kept.some((existing) => {
			const existingCenterX = existing.x + existing.templateWidth / 2;
			const existingCenterY = existing.y + existing.templateHeight * BASKET_BASE_Y_FRACTION;
			const dx = centerX - existingCenterX;
			const dy = centerY - existingCenterY;
			return dx * dx + dy * dy < nmsRadiusSquared;
		});
		if (tooClose) continue;
		kept.push(hit);
		if (kept.length === maxCandidates) break;
	}

	return kept.map((hit) => ({
		xPx: (hit.x + hit.templateWidth / 2) * raster.sourceScale,
		yPx: (hit.y + hit.templateHeight * BASKET_BASE_Y_FRACTION) * raster.sourceScale,
		score: hit.score,
		widthPx: hit.templateWidth * raster.sourceScale,
		heightPx: hit.templateHeight * raster.sourceScale,
		scale: hit.scale
	}));
}
