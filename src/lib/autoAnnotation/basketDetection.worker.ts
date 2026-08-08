import { loadCv } from '../stitch/cvMatch';
import { associateCourseGrammar } from './courseGrammar';
import { detectHoleNumberBadges } from './holeNumberDetection';
import type { HoleNumberTemplate } from './holeNumberDetection';
import { detectTeePadCandidates } from './teePadDetection';
import type { TeePadCv } from './teePadDetection';

const MAX_ANALYSIS_DIM = 2200;
const MIN_SCORE = 0.42;
const MAX_CANDIDATES = 18;
const SEARCH_SCALES = [0.65, 0.8, 0.95, 1.1, 1.3] as const;
const BASE_TEMPLATE_WIDTH = 82;
const BASE_TEMPLATE_HEIGHT = 105;
const BASKET_BASE_Y_FRACTION = 0.80;

interface BasketDetectionRequest {
	readonly kind: 'detect' | 'detect-course';
	readonly token: string;
	readonly bitmap: ImageBitmap;
	readonly widthPx: number;
	readonly heightPx: number;
}

interface BasketPrewarmRequest {
	readonly kind: 'prewarm';
	readonly token: string;
}

type BasketRequest = BasketDetectionRequest | BasketPrewarmRequest;

interface BasketCandidate {
	readonly xPx: number;
	readonly yPx: number;
	readonly score: number;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly scale: number;
}

type CvMat = {
	readonly rows: number;
	readonly cols: number;
	readonly data: Uint8Array | Float32Array;
	readonly data32F?: Float32Array;
	delete(): void;
};

type CvModule = {
	Mat: new (rows?: number, cols?: number, type?: number) => CvMat;
	CV_8UC1: number;
	TM_CCOEFF_NORMED: number;
	matchTemplate(image: CvMat, templ: CvMat, result: CvMat, method: number): void;
};

function grayscaleRaster(bitmap: ImageBitmap): {
	gray: Uint8Array;
	rgba: Uint8ClampedArray;
	width: number;
	height: number;
	scale: number;
} {
	const scale = Math.min(1, MAX_ANALYSIS_DIM / Math.max(bitmap.width, bitmap.height));
	const width = Math.max(1, Math.round(bitmap.width * scale));
	const height = Math.max(1, Math.round(bitmap.height * scale));
	const canvas = new OffscreenCanvas(width, height);
	const context = canvas.getContext('2d', { willReadFrequently: true });
	if (!context) throw new Error('Basket detection could not create an OffscreenCanvas context.');
	context.drawImage(bitmap, 0, 0, width, height);
	const rgba = context.getImageData(0, 0, width, height).data;
	const gray = new Uint8Array(width * height);
	for (let i = 0, j = 0; i < rgba.length; i += 4, j += 1) {
		gray[j] = (rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114 + 0.5) | 0;
	}
	return { gray, rgba, width, height, scale };
}

type AnalysisRaster = ReturnType<typeof grayscaleRaster>;

let templateBitmapPromise: Promise<ImageBitmap> | null = null;
let detectorRuntimePromise: Promise<CvModule> | null = null;
const templateRasterCache = new Map<string, Uint8Array>();

function loadTemplateBitmap(): Promise<ImageBitmap> {
	if (!templateBitmapPromise) {
		templateBitmapPromise = fetch(new URL('./basket-template.png', import.meta.url))
			.then((response) => {
				if (!response.ok) throw new Error(`Could not load basket template (${response.status}).`);
				return response.blob();
			})
			.then((blob) => createImageBitmap(blob));
		templateBitmapPromise.catch(() => {
			// A failed fetch/decode should not permanently poison a worker which
			// otherwise remains healthy (for example, after a transient asset load).
			templateBitmapPromise = null;
		});
	}
	return templateBitmapPromise;
}

async function basketTemplate(width: number, height: number): Promise<Uint8Array> {
	const cacheKey = `${width}x${height}`;
	const cached = templateRasterCache.get(cacheKey);
	if (cached) return cached;
	const bitmap = await loadTemplateBitmap();
	const canvas = new OffscreenCanvas(width, height);
	const context = canvas.getContext('2d', { willReadFrequently: true });
	if (!context) throw new Error('Basket detection could not create a template context.');
	context.drawImage(bitmap, 0, 0, width, height);
	const rgba = context.getImageData(0, 0, width, height).data;
	const gray = new Uint8Array(width * height);
	for (let i = 0, j = 0; i < rgba.length; i += 4, j += 1) {
		gray[j] = (rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114 + 0.5) | 0;
	}
	templateRasterCache.set(cacheKey, gray);
	return gray;
}

/**
 * Loads everything a detection needs once per worker. A shared promise means
 * a prewarm and a detection arriving close together do not instantiate OpenCV
 * twice. The queue below serializes jobs, but retaining this guard also makes
 * the initialization contract explicit if the worker's dispatch changes.
 */
function loadDetectorRuntime(): Promise<CvModule> {
	if (!detectorRuntimePromise) {
		detectorRuntimePromise = Promise.all([loadCv(), loadTemplateBitmap()])
			.then(([cv]) => {
				const runtime = cv as unknown as CvModule;
				// Exercise the OpenCV code path while prewarming. This is deliberately
				// tiny; it pays any per-runtime lazy setup without delaying a user click.
				const image = new runtime.Mat(8, 8, runtime.CV_8UC1);
				const template = new runtime.Mat(4, 4, runtime.CV_8UC1);
				const result = new runtime.Mat();
				try {
					runtime.matchTemplate(image, template, result, runtime.TM_CCOEFF_NORMED);
				} finally {
					image.delete();
					template.delete();
					result.delete();
				}
				return runtime;
			})
			.catch((error) => {
				// Permit a later prewarm/detection to retry after a temporary network or
				// WASM initialization failure instead of keeping a rejected promise.
				detectorRuntimePromise = null;
				throw error;
			});
	}
	return detectorRuntimePromise;
}

function matFromBytes(cv: CvModule, bytes: Uint8Array, rows: number, cols: number): CvMat {
	const mat = new cv.Mat(rows, cols, cv.CV_8UC1);
	(mat.data as Uint8Array).set(bytes);
	return mat;
}

function addScaleCandidates(
	result: CvMat,
	imageScale: number,
	templateScale: number,
	templateWidth: number,
	templateHeight: number,
	into: BasketCandidate[]
): void {
	// OpenCV.js exposes CV_32F results through data32F. Reading data instead
	// interprets the float bytes as 8-bit pixels, producing bogus scores like
	// 25500% in the UI.
	const values = result.data32F ?? (result.data as Float32Array);
	const top: Array<{ x: number; y: number; score: number }> = [];
	for (let index = 0; index < values.length; index += 1) {
		const score = values[index];
		if (score < MIN_SCORE) continue;
		const x = index % result.cols;
		const y = Math.floor(index / result.cols);
		// Keep response-map local maxima, matching the proven Python parser's
		// dilation/NMS step. Without this, adjacent pixels from one strong basket
		// can fill the bounded top set and crowd every other basket out.
		let localMaximum = true;
		for (let dy = -1; dy <= 1 && localMaximum; dy += 1) {
			const neighborY = y + dy;
			if (neighborY < 0 || neighborY >= result.rows) continue;
			for (let dx = -1; dx <= 1; dx += 1) {
				if (dx === 0 && dy === 0) continue;
				const neighborX = x + dx;
				if (neighborX < 0 || neighborX >= result.cols) continue;
				if (values[neighborY * result.cols + neighborX] > score) {
					localMaximum = false;
					break;
				}
			}
		}
		if (!localMaximum) continue;
		const candidate = {
			x,
			y,
			score
		};
		// Keep a bounded high-score set per scale; this avoids sorting millions of
		// response pixels while still retaining every plausible local maximum.
		if (top.length < 128) {
			top.push(candidate);
			continue;
		}
		let lowestIndex = 0;
		for (let i = 1; i < top.length; i += 1) {
			if (top[i].score < top[lowestIndex].score) lowestIndex = i;
		}
		if (score > top[lowestIndex].score) top[lowestIndex] = candidate;
	}
	top.sort((a, b) => b.score - a.score);
	for (const hit of top) {
		const widthPx = templateWidth / imageScale;
		const heightPx = templateHeight / imageScale;
		const xPx = (hit.x + templateWidth * 0.5) / imageScale;
		const yPx = (hit.y + templateHeight * BASKET_BASE_Y_FRACTION) / imageScale;
		const radius = Math.max(18, Math.min(widthPx, heightPx) * 0.45);
		if (into.some((existing) => Math.hypot(existing.xPx - xPx, existing.yPx - yPx) < radius)) {
			continue;
		}
		into.push({ xPx, yPx, score: hit.score, widthPx, heightPx, scale: templateScale });
		if (into.length >= MAX_CANDIDATES * 3) return;
	}
}

async function detect(
	request: BasketDetectionRequest,
	existingRaster?: AnalysisRaster
): Promise<readonly BasketCandidate[]> {
	const cv = await loadDetectorRuntime();
	const raster = existingRaster ?? grayscaleRaster(request.bitmap);
	const image = matFromBytes(cv, raster.gray, raster.height, raster.width);
	const candidates: BasketCandidate[] = [];
	try {
		for (const templateScale of SEARCH_SCALES) {
			const templateWidth = Math.max(10, Math.round(BASE_TEMPLATE_WIDTH * templateScale * raster.scale));
			const templateHeight = Math.max(14, Math.round(BASE_TEMPLATE_HEIGHT * templateScale * raster.scale));
			if (templateWidth >= raster.width || templateHeight >= raster.height) continue;
			const template = matFromBytes(
				cv,
				await basketTemplate(templateWidth, templateHeight),
				templateHeight,
				templateWidth
			);
			const result = new cv.Mat();
			try {
				cv.matchTemplate(image, template, result, cv.TM_CCOEFF_NORMED);
				addScaleCandidates(
					result,
					raster.scale,
					templateScale,
					templateWidth,
					templateHeight,
					candidates
				);
			} finally {
				template.delete();
				result.delete();
			}
		}
	} finally {
		image.delete();
	}

	return candidates
		.sort((a, b) => b.score - a.score)
		.slice(0, MAX_CANDIDATES)
		.map((candidate) => ({
			...candidate,
			xPx: Math.max(0, Math.min(request.widthPx, candidate.xPx)),
			yPx: Math.max(0, Math.min(request.heightPx, candidate.yPx))
		}));
}

const templateUrls = import.meta.glob<string>('./hole-number-templates/hole-*.png', {
	eager: true,
	query: '?url',
	import: 'default'
});
let holeTemplatesPromise: Promise<readonly HoleNumberTemplate[]> | null = null;

function loadHoleNumberTemplates(): Promise<readonly HoleNumberTemplate[]> {
	if (holeTemplatesPromise) return holeTemplatesPromise;
	holeTemplatesPromise = Promise.all(
		Object.entries(templateUrls).map(async ([path, url]) => {
			const match = /hole-(\d{2})\.png$/.exec(path);
			if (!match) throw new Error(`Invalid hole-number template name: ${path}`);
			const response = await fetch(url);
			if (!response.ok) throw new Error(`Could not load ${path} (${response.status}).`);
			const bitmap = await createImageBitmap(await response.blob());
			try {
				const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
				const context = canvas.getContext('2d', { willReadFrequently: true });
				if (!context) throw new Error(`Could not rasterize ${path}.`);
				context.drawImage(bitmap, 0, 0);
				return {
					label: Number(match[1]),
					raster: {
						format: 'rgba' as const,
						widthPx: bitmap.width,
						heightPx: bitmap.height,
						data: new Uint8Array(context.getImageData(0, 0, bitmap.width, bitmap.height).data)
					}
				};
			} finally {
				bitmap.close();
			}
		})
	).then((templates) => templates.sort((a, b) => a.label - b.label));
	return holeTemplatesPromise;
}

function median(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

async function detectCourse(request: BasketDetectionRequest) {
	const cv = await loadDetectorRuntime();
	const raster = grayscaleRaster(request.bitmap);
	const baskets = await detect(request, raster);
	const templates = await loadHoleNumberTemplates();
	const detectedNumbers = detectHoleNumberBadges(
		cv,
		{ format: 'gray', widthPx: raster.width, heightPx: raster.height, data: raster.gray },
		templates
	);

	const sourceScale = 1 / raster.scale;
	const numberDetection = {
		...detectedNumbers,
		candidates: detectedNumbers.candidates.map((candidate) => ({
			...candidate,
			xPx: candidate.xPx * sourceScale,
			yPx: candidate.yPx * sourceScale,
			widthPx: candidate.widthPx * sourceScale,
			heightPx: candidate.heightPx * sourceScale
		})),
		anchor: detectedNumbers.anchor
			? {
					...detectedNumbers.anchor,
					scale: detectedNumbers.anchor.scale * sourceScale,
					xPx: detectedNumbers.anchor.xPx * sourceScale,
					yPx: detectedNumbers.anchor.yPx * sourceScale,
					widthPx: detectedNumbers.anchor.widthPx * sourceScale,
					heightPx: detectedNumbers.anchor.heightPx * sourceScale
				}
			: null
	};
	const uiScalePx = numberDetection.anchor
		? numberDetection.anchor.scale
		: median(baskets.map((candidate) => candidate.scale));
	const tees = uiScalePx
		? detectTeePadCandidates(
				cv as unknown as TeePadCv,
				{
					rgba: raster.rgba,
					widthPx: raster.width,
					heightPx: raster.height,
					sourceScale
				},
				{ uiScalePx }
			)
		: [];

	const numberBadges = numberDetection.candidates.map((candidate) => ({
		xPx: candidate.xPx,
		yPx: candidate.yPx,
		score: candidate.score,
		holeNumber: candidate.label
	}));
	const grammar = associateCourseGrammar({ numberBadges, tees, baskets });
	return { numberDetection, tees, baskets, grammar };
}

async function processRequest(request: BasketRequest): Promise<void> {
	try {
		if (request.kind === 'prewarm') {
			await loadDetectorRuntime();
			(self as unknown as Worker).postMessage({ ok: true, kind: request.kind, token: request.token });
			return;
		}

		if (request.kind === 'detect-course') {
			const course = await detectCourse(request);
			(self as unknown as Worker).postMessage({
				ok: true,
				kind: request.kind,
				token: request.token,
				course
			});
			return;
		}

		const candidates = await detect(request);
		(self as unknown as Worker).postMessage({
			ok: true,
			kind: request.kind,
			token: request.token,
			candidates
		});
	} catch (error) {
		(self as unknown as Worker).postMessage({
			ok: false,
			kind: request.kind,
			token: request.token,
			message: error instanceof Error ? error.message : String(error)
		});
	} finally {
		if (request.kind !== 'prewarm') request.bitmap.close();
	}
}

// matchTemplate allocates sizeable WASM Mats. Queue all detector jobs so two
// clicks (or a prewarm racing a click) cannot run competing OpenCV operations
// in one worker. Failures are handled inside processRequest, keeping the queue
// alive for the next request.
let queuedWork: Promise<void> = Promise.resolve();

self.onmessage = (event: MessageEvent<BasketRequest>) => {
	const request = event.data;
	queuedWork = queuedWork.then(
		() => processRequest(request),
		() => processRequest(request)
	);
};
