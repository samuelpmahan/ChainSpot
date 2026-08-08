/**
 * Transport-free basket proposal detection.
 *
 * The detector matches the clean canonical basket glyph from
 * `static/resources/chainspot_cv_templates/basket.png`. Callers provide the
 * already-decoded grayscale raster and OpenCV instance, so this module can be
 * shared by the browser worker and the diagnostic CLI without loading assets,
 * decoding images, or mutating editor state.
 */

export interface BasketRaster {
	readonly gray: Uint8Array;
	readonly widthPx: number;
	readonly heightPx: number;
	/** Source pixels represented by one raster pixel (1 for full resolution). */
	readonly sourceScale: number;
}

export interface BasketTemplateRaster {
	readonly gray: Uint8Array;
	readonly widthPx: number;
	readonly heightPx: number;
}

export interface BasketCandidate {
	/** Semantic endpoint: the bottom-center stem base, not the glyph center. */
	readonly xPx: number;
	readonly yPx: number;
	readonly score: number;
	readonly widthPx: number;
	readonly heightPx: number;
	/** Canonical-template scale in source-image pixels. */
	readonly scale: number;
}

export interface BasketDetectionOptions {
	/** Source-image pixels per canonical basket-template pixel. */
	readonly uiScalePx: number;
	/** Optional source-image vertical map extent. Everything outside is ignored. */
	readonly mapBoundsPx?: Readonly<{ topPx: number; bottomPx: number }>;
	/** Keep at most this many candidates. Defaults to the 18-hole MVP. */
	readonly maxCandidates?: number;
	/** Minimum normalized cross-correlation score. Defaults to 0.50. */
	readonly minScore?: number;
	/**
	 * Exact canonical-template scales in the supplied raster's pixels. This is
	 * used only for the bounded browser fallback ladder; normal detection uses
	 * the nine samples around `uiScalePx` below.
	 */
	readonly templateScales?: readonly number[];
}

type CvMat = {
	readonly rows: number;
	readonly cols: number;
	readonly data: Uint8Array | Float32Array;
	readonly data32F?: Float32Array;
	delete(): void;
};

/** Narrow OpenCV surface used by this detector. */
export interface BasketCv {
	Mat: new (rows?: number, cols?: number, type?: number) => CvMat;
	Size: new (width: number, height: number) => unknown;
	CV_8UC1: number;
	TM_CCOEFF_NORMED: number;
	INTER_AREA: number;
	INTER_CUBIC: number;
	matchTemplate(image: CvMat, templ: CvMat, result: CvMat, method: number): void;
	resize(source: CvMat, destination: CvMat, size: unknown, fx: number, fy: number, interpolation: number): void;
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
/** Bottom-center stem base, not the glyph/icon center. */
const BASKET_BASE_Y_FRACTION = 0.96;
/** The probe's 11x11 local-max suppression window has radius five. */
const LOCAL_MAXIMUM_RADIUS = 5;

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.max(minimum, Math.min(maximum, value));
}

function scaleSamples(uiScalePx: number, sourceScale: number): number[] {
	const sourceScaleInRaster = uiScalePx / sourceScale;
	const samples: number[] = [];
	for (let index = 0; index < SCALE_SAMPLE_COUNT; index += 1) {
		const fraction = index / (SCALE_SAMPLE_COUNT - 1);
		samples.push(sourceScaleInRaster * (SCALE_RANGE_LOW + fraction * (SCALE_RANGE_HIGH - SCALE_RANGE_LOW)));
	}
	return samples;
}

function matFromBytes(cv: BasketCv, bytes: Uint8Array, width: number, height: number): CvMat {
	const mat = new cv.Mat(height, width, cv.CV_8UC1);
	(mat.data as Uint8Array).set(bytes);
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
	/** Coarse blind sweep bounds, as a multiple of the canonical template. */
	readonly scaleRangeLow?: number;
	readonly scaleRangeHigh?: number;
	/** Sweep step size. */
	readonly scaleStep?: number;
	/** Optional diagnostic progress callback, called once per evaluated scale. */
	readonly onProgress?: (result: Readonly<{ scale: number; score: number }>) => void;
}

const DEFAULT_ANCHOR_SCALE_RANGE_LOW = 0.4;
const DEFAULT_ANCHOR_SCALE_RANGE_HIGH = 4.0;
const DEFAULT_ANCHOR_SCALE_STEP = 0.05;

/**
 * Finds the basket template's own scale via a broad blind sweep. This is for
 * the offline/diagnostic CLI only: browser startup must use a bounded scale
 * path because every sweep step performs a full-image matchTemplate pass.
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
	if (!(scaleRangeHigh > scaleRangeLow) || !(scaleStep > 0)) {
		throw new Error('findBasketAnchorScale requires scaleRangeHigh > scaleRangeLow and a positive scaleStep.');
	}

	const image = matFromBytes(cv, raster.gray, raster.widthPx, raster.heightPx);
	let best: BasketAnchorScale | null = null;
	try {
		for (let scale = scaleRangeLow; scale <= scaleRangeHigh + 1e-9; scale += scaleStep) {
			const resized = resizeTemplate(cv, template, scale);
			try {
				if (resized.cols >= raster.widthPx || resized.rows >= raster.heightPx) continue;
				const result = new cv.Mat();
				try {
					cv.matchTemplate(image, resized, result, cv.TM_CCOEFF_NORMED);
					const { maxVal } = cv.minMaxLoc(result);
					options.onProgress?.({ scale: scale * raster.sourceScale, score: maxVal });
					if (!best || maxVal > best.score) {
						best = { scale: scale * raster.sourceScale, score: maxVal };
					}
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
	return best;
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
 * Collect response-map local maxima using an 11x11 neighborhood. The larger
 * window prevents adjacent pixels from one strong basket from crowding real
 * baskets out of the bounded candidate set across multiple scale passes.
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
	if (template.gray.length < template.widthPx * template.heightPx) {
		throw new Error('Basket detection template does not contain grayscale pixels for its dimensions.');
	}
	if (!Number.isFinite(options.uiScalePx) || options.uiScalePx <= 0) {
		throw new Error('Basket detection requires a positive uiScalePx.');
	}
	if (
		options.templateScales?.some((scale) => !Number.isFinite(scale) || scale <= 0) ||
		(options.templateScales !== undefined && options.templateScales.length === 0)
	) {
		throw new Error('Basket detection templateScales must contain positive finite values.');
	}
}

/**
 * Detect basket proposals from a grayscale raster. All temporary OpenCV Mats
 * are freed before this function returns or throws.
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

	const templateScales = options.templateScales ?? scaleSamples(options.uiScalePx, raster.sourceScale);
	const image = matFromBytes(cv, raster.gray, raster.widthPx, raster.heightPx);
	const hits: RawHit[] = [];
	try {
		for (const templateScale of templateScales) {
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
	const nominalScale = options.uiScalePx / raster.sourceScale;
	const nmsRadius = Math.max(16, 22 * nominalScale);
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
		scale: hit.scale * raster.sourceScale
	}));
}
