import { loadCv } from '../stitch/cvMatch';
import { associateCourseGrammar } from './courseGrammar';
import { detectHoleNumberBadges } from './holeNumberDetection';
import type { HoleNumberTemplate } from './holeNumberDetection';
import { detectBasketTemplateCandidates } from './basketTemplateDetection';
import type { BasketCandidate, BasketCv, BasketTemplateRaster } from './basketTemplateDetection';
import { detectTeePadCandidates, detectTeePadVariants } from './teePadDetection';
import type { TeePadCv, TeePadVariant, TeePadVariantResult } from './teePadDetection';

const MAX_ANALYSIS_DIM = 2200;
const MIN_SCORE = 0.42;
const MAX_CANDIDATES = 18;
/**
 * Bounded canonical basket-template scales in source-image pixels. Both basket
 * browser entry points retain this compatibility ladder; number-derived scale
 * selection remains part of the existing tee path only.
 */
const BROWSER_BASKET_SCALES = [0.65, 0.8, 0.95, 1.1, 1.3] as const;
const BASKET_TEMPLATE_URL = '/resources/chainspot_cv_templates/basket.png';

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

interface TeeDetectionRequest {
	readonly kind: 'detect-tees';
	readonly token: string;
	readonly bitmap: ImageBitmap;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly variants: readonly TeePadVariant[];
	readonly uiScalePx?: number;
	readonly mapBoundsPx?: { topPx: number; bottomPx: number };
	readonly fullResolution?: boolean;
}

type BasketRequest = BasketDetectionRequest | BasketPrewarmRequest | TeeDetectionRequest;

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

function fullResolutionRaster(bitmap: ImageBitmap): {
	rgba: Uint8ClampedArray;
	width: number;
	height: number;
} {
	const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
	const context = canvas.getContext('2d', { willReadFrequently: true });
	if (!context) throw new Error('Tee detection could not create an OffscreenCanvas context.');
	context.drawImage(bitmap, 0, 0);
	return { rgba: context.getImageData(0, 0, bitmap.width, bitmap.height).data, width: bitmap.width, height: bitmap.height };
}

type AnalysisRaster = ReturnType<typeof grayscaleRaster>;

let detectorRuntimePromise: Promise<CvModule> | null = null;
let basketTemplatePromise: Promise<BasketTemplateRaster> | null = null;

function loadBasketTemplate(): Promise<BasketTemplateRaster> {
	if (!basketTemplatePromise) {
		basketTemplatePromise = fetch(BASKET_TEMPLATE_URL)
			.then((response) => {
				if (!response.ok) throw new Error(`Could not load basket template (${response.status}).`);
				return response.blob();
			})
			.then((blob) => createImageBitmap(blob))
			.then((bitmap) => {
				const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
				const context = canvas.getContext('2d', { willReadFrequently: true });
				if (!context) throw new Error('Basket detection could not create a template context.');
				context.drawImage(bitmap, 0, 0);
				const rgba = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
				const gray = new Uint8Array(bitmap.width * bitmap.height);
				for (let i = 0, j = 0; i < rgba.length; i += 4, j += 1) {
					gray[j] = (rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114 + 0.5) | 0;
				}
				bitmap.close();
				return { gray, widthPx: canvas.width, heightPx: canvas.height };
			});
		basketTemplatePromise.catch(() => {
			// A failed fetch/decode should not permanently poison a worker which
			// otherwise remains healthy (for example, after a transient asset load).
			basketTemplatePromise = null;
		});
	}
	return basketTemplatePromise;
}

/**
 * Loads everything a detection needs once per worker. A shared promise means
 * a prewarm and a detection arriving close together do not instantiate OpenCV
 * twice. The queue below serializes jobs, but retaining this guard also makes
 * the initialization contract explicit if the worker's dispatch changes.
 */
function loadDetectorRuntime(): Promise<CvModule> {
	if (!detectorRuntimePromise) {
		detectorRuntimePromise = Promise.all([loadCv(), loadBasketTemplate()])
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

async function detect(
	request: BasketDetectionRequest,
	existingRaster?: AnalysisRaster
): Promise<readonly BasketCandidate[]> {
	const cv = await loadDetectorRuntime();
	const raster = existingRaster ?? grayscaleRaster(request.bitmap);
	const template = await loadBasketTemplate();
	const sourceScale = 1 / raster.scale;
	const candidates = detectBasketTemplateCandidates(
		cv as unknown as BasketCv,
		{
			gray: raster.gray,
			widthPx: raster.width,
			heightPx: raster.height,
			sourceScale
		},
		template,
		{
			// The basket-only route has no number anchor. Keep its historical,
			// bounded scale ladder rather than paying a blind sweep in the worker.
			uiScalePx: sourceScale,
			templateScales: BROWSER_BASKET_SCALES.map((scale) => scale * raster.scale),
			maxCandidates: MAX_CANDIDATES,
			minScore: MIN_SCORE
		}
	);

	return candidates
		.map((candidate) => ({
			...candidate,
			xPx: Math.max(0, Math.min(request.widthPx, candidate.xPx)),
			yPx: Math.max(0, Math.min(request.heightPx, candidate.yPx))
		}));
}

const HOLE_TEMPLATE_BASE_URL = '/resources/chainspot_cv_templates';
let holeTemplatesPromise: Promise<readonly HoleNumberTemplate[]> | null = null;

function loadHoleNumberTemplates(): Promise<readonly HoleNumberTemplate[]> {
	if (holeTemplatesPromise) return holeTemplatesPromise;
	holeTemplatesPromise = Promise.all(
		Array.from({ length: 18 }, async (_, index) => {
			const label = index + 1;
			const fileName = `hole-${String(label).padStart(2, '0')}.png`;
			const url = `${HOLE_TEMPLATE_BASE_URL}/${fileName}`;
			const response = await fetch(url);
			if (!response.ok) throw new Error(`Could not load ${url} (${response.status}).`);
			const bitmap = await createImageBitmap(await response.blob());
			try {
				const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
				const context = canvas.getContext('2d', { willReadFrequently: true });
				if (!context) throw new Error(`Could not rasterize ${url}.`);
				context.drawImage(bitmap, 0, 0);
				return {
					label,
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
	);
	return holeTemplatesPromise;
}

function median(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function deriveMapBoundsFromNumbers(
	candidates: readonly { readonly label?: number; readonly yPx: number }[],
	heightPx: number
): { topPx: number; bottomPx: number } | undefined {
	const labeled = candidates.filter((candidate) => candidate.label !== undefined);
	if (labeled.length < 3) return undefined;
	const ys = labeled.map((candidate) => candidate.yPx);
	const minY = Math.min(...ys);
	const maxY = Math.max(...ys);
	const spread = maxY - minY;
	const margin = Math.max(80, Math.min(300, spread * 0.3));
	return {
		topPx: Math.max(0, minY - margin),
		bottomPx: Math.min(heightPx, maxY + margin)
	};
}

async function deriveUiScaleAndMapBounds(
	request: TeeDetectionRequest,
	cv: CvModule,
	raster: AnalysisRaster
): Promise<{ uiScalePx: number; mapBoundsPx?: { topPx: number; bottomPx: number } }> {
	if (Number.isFinite(request.uiScalePx) && (request.uiScalePx ?? 0) > 0) {
		return { uiScalePx: request.uiScalePx as number, mapBoundsPx: request.mapBoundsPx };
	}

	const templates = await loadHoleNumberTemplates();
	const detectedNumbers = detectHoleNumberBadges(
		cv,
		{ format: 'gray', widthPx: raster.width, heightPx: raster.height, data: raster.gray },
		templates
	);
	if (!detectedNumbers.anchor) {
		throw new Error(detectedNumbers.note ?? 'Could not derive UI scale from hole-number templates.');
	}

	const sourceScale = 1 / raster.scale;
	const uiScalePx = detectedNumbers.anchor.scale * sourceScale;
	const mapBoundsPx =
		request.mapBoundsPx ??
		deriveMapBoundsFromNumbers(
			detectedNumbers.candidates.map((candidate) => ({
				...candidate,
				yPx: candidate.yPx * sourceScale
			})),
			request.heightPx
		);
	return { uiScalePx, mapBoundsPx };
}

async function detectTees(
	request: TeeDetectionRequest
): Promise<{ uiScalePx: number; results: readonly TeePadVariantResult[] }> {
	const cv = await loadDetectorRuntime();
	const analysisRaster = grayscaleRaster(request.bitmap);
	const { uiScalePx, mapBoundsPx } = await deriveUiScaleAndMapBounds(request, cv, analysisRaster);

	const teeRaster = request.fullResolution
		? (() => {
				const full = fullResolutionRaster(request.bitmap);
				return {
					rgba: full.rgba,
					widthPx: full.width,
					heightPx: full.height,
					sourceScale: 1
				};
			})()
		: {
				rgba: analysisRaster.rgba,
				widthPx: analysisRaster.width,
				heightPx: analysisRaster.height,
				sourceScale: 1 / analysisRaster.scale
			};

	const results = detectTeePadVariants(
		cv as unknown as TeePadCv,
		teeRaster,
		{ uiScalePx, mapBoundsPx },
		request.variants
	);
	return { uiScalePx, results };
}

function reportCourseProgress(
	request: BasketDetectionRequest,
	stage: 'opencv' | 'baskets' | 'templates' | 'numbers' | 'tees' | 'grammar',
	message: string
): void {
	(self as unknown as Worker).postMessage({
		ok: true,
		kind: 'progress',
		token: request.token,
		progress: { stage, message }
	});
}

async function detectCourse(request: BasketDetectionRequest) {
	reportCourseProgress(request, 'opencv', 'Loading OpenCV runtime…');
	const cv = await loadDetectorRuntime();
	const raster = grayscaleRaster(request.bitmap);

	reportCourseProgress(request, 'baskets', 'OpenCV ready · detecting baskets…');
	const baskets = await detect(request, raster);

	reportCourseProgress(request, 'templates', `${baskets.length} baskets found · loading 18 number templates…`);
	const templates = await loadHoleNumberTemplates();

	reportCourseProgress(request, 'numbers', `${templates.length} templates loaded · matching hole numbers…`);
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
	reportCourseProgress(
		request,
		'tees',
		`${numberDetection.candidates.filter((candidate) => candidate.label !== undefined).length} numbers assigned · detecting tee pads…`
	);
	// Tee-pad rectangles are tiny (roughly 13x8 UI px), and their size/aspect
	// thresholds are tuned tight against full-resolution pixels, so detection
	// runs on the full-resolution raster rather than the MAX_ANALYSIS_DIM
	// raster used for basket/number matching. The search is also restricted to
	// the course-map row band derived from the number badges so off-map UI
	// chrome cannot crowd real pads out of the maxCandidates slice.
	const mapBoundsPx = deriveMapBoundsFromNumbers(numberDetection.candidates, request.heightPx);
	const tees = uiScalePx
		? detectTeePadCandidates(
				cv as unknown as TeePadCv,
				{
					rgba: fullResolutionRaster(request.bitmap).rgba,
					widthPx: request.widthPx,
					heightPx: request.heightPx,
					sourceScale: 1
				},
				{ uiScalePx, mapBoundsPx }
			)
		: [];

	const numberBadges = numberDetection.candidates.map((candidate) => ({
		xPx: candidate.xPx,
		yPx: candidate.yPx,
		score: candidate.score,
		holeNumber: candidate.label
	}));
	reportCourseProgress(
		request,
		'grammar',
		`${tees.length} tees found · matching numbers, tees, and baskets…`
	);
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

		if (request.kind === 'detect-tees') {
			const { uiScalePx, results } = await detectTees(request);
			(self as unknown as Worker).postMessage({
				ok: true,
				kind: request.kind,
				token: request.token,
				uiScalePx,
				results
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
