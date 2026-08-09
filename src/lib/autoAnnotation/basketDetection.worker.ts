import { loadCv } from '../stitch/cvMatch';
import { associateCourseGrammar } from './courseGrammar';
import type {
	HoleNumberCvModule,
	HoleNumberTemplate
} from './holeNumberDetection';
import type {
	BasketCv,
	BasketTemplateRaster
} from './basketTemplateDetection';
import type {
	TeePadCv,
	TeePadVariant,
	TeePadVariantResult
} from './teePadDetection';
import {
	detectBasketCandidatesAtTemplateScale,
	detectCalibratedHoleNumberBadges,
	detectCalibratedTeePadCandidates,
	detectCalibratedTeePadVariants,
	findCalibratedBasketAnchorScale
} from './cvCalibratedDetectors';
import type { CalibratedBasketCandidate } from './cvCalibratedDetectors';
import {
	asUiScalePx,
	deriveUDiscCalibration,
	validateCvTemplateManifest
} from './cvCalibration';
import type {
	CvTemplateManifest,
	UiScalePx
} from './cvCalibration';

const MAX_ANALYSIS_DIM = 2200;
const TEMPLATE_BASE_URL = '/resources/chainspot_cv_templates';

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
	readonly uiScalePx?: UiScalePx;
	readonly mapBoundsPx?: { topPx: number; bottomPx: number };
	readonly fullResolution?: boolean;
}

type BasketRequest = BasketDetectionRequest | BasketPrewarmRequest | TeeDetectionRequest;
type RuntimeCv = BasketCv & TeePadCv & HoleNumberCvModule;

type AnalysisRaster = ReturnType<typeof grayscaleRaster>;

interface LoadedTemplatePack {
	readonly manifest: CvTemplateManifest;
	readonly holeNumbers: readonly HoleNumberTemplate[];
	readonly basket: BasketTemplateRaster;
}

let runtimePromise: Promise<RuntimeCv> | null = null;
let templatePackPromise: Promise<LoadedTemplatePack> | null = null;

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
	if (!context) throw new Error('CV detection could not create an OffscreenCanvas context.');
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
	if (!context) throw new Error('CV detection could not create a full-resolution canvas.');
	context.drawImage(bitmap, 0, 0);
	return {
		rgba: context.getImageData(0, 0, bitmap.width, bitmap.height).data,
		width: bitmap.width,
		height: bitmap.height
	};
}

function grayscaleRgba(rgba: Uint8ClampedArray, pixelCount: number): Uint8Array {
	const gray = new Uint8Array(pixelCount);
	for (let i = 0, j = 0; i < rgba.length; i += 4, j += 1) {
		gray[j] = (rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114 + 0.5) | 0;
	}
	return gray;
}

async function fetchAsset(fileName: string): Promise<Blob> {
	const url = `${TEMPLATE_BASE_URL}/${fileName}`;
	const response = await fetch(url);
	if (!response.ok) throw new Error(`CV template manifest asset ${fileName} could not be loaded (${response.status}).`);
	return response.blob();
}

async function rasterizeNumberTemplate(label: number, fileName: string): Promise<HoleNumberTemplate> {
	const bitmap = await createImageBitmap(await fetchAsset(fileName));
	try {
		const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
		const context = canvas.getContext('2d', { willReadFrequently: true });
		if (!context) throw new Error(`Could not rasterize CV template ${fileName}.`);
		context.drawImage(bitmap, 0, 0);
		return {
			label,
			raster: {
				format: 'rgba',
				widthPx: bitmap.width,
				heightPx: bitmap.height,
				data: new Uint8Array(context.getImageData(0, 0, bitmap.width, bitmap.height).data)
			}
		};
	} finally {
		bitmap.close();
	}
}

async function rasterizeBasketTemplate(fileName: string): Promise<BasketTemplateRaster> {
	const bitmap = await createImageBitmap(await fetchAsset(fileName));
	try {
		const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
		const context = canvas.getContext('2d', { willReadFrequently: true });
		if (!context) throw new Error(`Could not rasterize CV template ${fileName}.`);
		context.drawImage(bitmap, 0, 0);
		const rgba = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
		return {
			gray: grayscaleRgba(rgba, bitmap.width * bitmap.height),
			widthPx: bitmap.width,
			heightPx: bitmap.height
		};
	} finally {
		bitmap.close();
	}
}

function loadTemplatePack(): Promise<LoadedTemplatePack> {
	if (templatePackPromise) return templatePackPromise;
	templatePackPromise = fetch(`${TEMPLATE_BASE_URL}/manifest.json`)
		.then(async (response) => {
			if (!response.ok) throw new Error(`CV template manifest could not be loaded (${response.status}).`);
			const manifest = validateCvTemplateManifest(await response.json());
			const [holeNumbers, basket] = await Promise.all([
				Promise.all(
					manifest.templates.holeNumbers.map((fileName, index) =>
						rasterizeNumberTemplate(index + 1, fileName)
					)
				),
				rasterizeBasketTemplate(manifest.templates.basket)
			]);
			return { manifest, holeNumbers, basket };
		})
		.catch((error) => {
			templatePackPromise = null;
			throw error;
		});
	return templatePackPromise;
}

function loadRuntime(): Promise<RuntimeCv> {
	if (runtimePromise) return runtimePromise;
	runtimePromise = Promise.all([loadCv(), loadTemplatePack()])
		.then(([cv]) => cv as unknown as RuntimeCv)
		.catch((error) => {
			runtimePromise = null;
			throw error;
		});
	return runtimePromise;
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

async function detectBaskets(
	bitmap: ImageBitmap,
	widthPx: number,
	heightPx: number,
	mapBoundsPx?: { topPx: number; bottomPx: number }
): Promise<readonly CalibratedBasketCandidate[]> {
	const [cv, pack] = await Promise.all([loadRuntime(), loadTemplatePack()]);
	const full = fullResolutionRaster(bitmap);
	const raster = {
		gray: grayscaleRgba(full.rgba, full.width * full.height),
		widthPx: full.width,
		heightPx: full.height,
		sourceScale: 1
	};
	const anchor = findCalibratedBasketAnchorScale(cv, raster, pack.basket);
	if (!anchor) return [];
	return detectBasketCandidatesAtTemplateScale(cv, raster, pack.basket, {
		templateScale: anchor.scale,
		mapBoundsPx
	}).map((candidate) => ({
		...candidate,
		xPx: Math.max(0, Math.min(widthPx, candidate.xPx)),
		yPx: Math.max(0, Math.min(heightPx, candidate.yPx))
	}));
}

function sourceNumberDetection(
	detection: ReturnType<typeof detectCalibratedHoleNumberBadges>,
	sourceScale: number
) {
	return {
		...detection,
		candidates: detection.candidates.map((candidate) => ({
			...candidate,
			xPx: candidate.xPx * sourceScale,
			yPx: candidate.yPx * sourceScale,
			widthPx: candidate.widthPx * sourceScale,
			heightPx: candidate.heightPx * sourceScale
		})),
		anchor: detection.anchor
			? {
					...detection.anchor,
					// TemplateScale describes the actual template resize multiplier. It
					// is intentionally NOT multiplied by source-coordinate scale.
					scale: detection.anchor.scale,
					xPx: detection.anchor.xPx * sourceScale,
					yPx: detection.anchor.yPx * sourceScale,
					widthPx: detection.anchor.widthPx * sourceScale,
					heightPx: detection.anchor.heightPx * sourceScale
				}
			: null
	};
}

async function deriveUiScaleAndMapBounds(
	request: TeeDetectionRequest,
	cv: RuntimeCv,
	raster: AnalysisRaster
): Promise<{ uiScalePx: UiScalePx; mapBoundsPx?: { topPx: number; bottomPx: number } }> {
	if (request.uiScalePx !== undefined) {
		return {
			uiScalePx: asUiScalePx(request.uiScalePx, 'Explicit tee UI scale'),
			mapBoundsPx: request.mapBoundsPx
		};
	}

	const pack = await loadTemplatePack();
	const detected = detectCalibratedHoleNumberBadges(
		cv,
		{ format: 'gray', widthPx: raster.width, heightPx: raster.height, data: raster.gray },
		pack.holeNumbers
	);
	if (!detected.anchor) {
		throw new Error(
			detected.note ?? 'Tee detection requires a number-badge anchor or an explicit UiScalePx calibration.'
		);
	}
	const sourceScale = 1 / raster.scale;
	const source = sourceNumberDetection(detected, sourceScale);
	const calibration = deriveUDiscCalibration(
		{
			scale: source.anchor!.scale,
			widthPx: source.anchor!.widthPx,
			heightPx: source.anchor!.heightPx
		},
		pack.manifest.calibration.canonicalNumberBadge
	);
	return {
		uiScalePx: calibration.uiScalePx,
		mapBoundsPx:
			request.mapBoundsPx ?? deriveMapBoundsFromNumbers(source.candidates, request.heightPx)
	};
}

async function detectTees(
	request: TeeDetectionRequest
): Promise<{ uiScalePx: UiScalePx; results: readonly TeePadVariantResult[] }> {
	const cv = await loadRuntime();
	const analysis = grayscaleRaster(request.bitmap);
	const { uiScalePx, mapBoundsPx } = await deriveUiScaleAndMapBounds(request, cv, analysis);
	const raster = request.fullResolution
		? (() => {
				const full = fullResolutionRaster(request.bitmap);
				return { rgba: full.rgba, widthPx: full.width, heightPx: full.height, sourceScale: 1 };
			})()
		: {
				rgba: analysis.rgba,
				widthPx: analysis.width,
				heightPx: analysis.height,
				sourceScale: 1 / analysis.scale
			};
	return {
		uiScalePx,
		results: detectCalibratedTeePadVariants(cv, raster, { uiScalePx, mapBoundsPx }, request.variants)
	};
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
	reportCourseProgress(request, 'opencv', 'Loading OpenCV runtime and CV calibration manifest…');
	const [cv, pack] = await Promise.all([loadRuntime(), loadTemplatePack()]);
	const analysis = grayscaleRaster(request.bitmap);

	// Preserve the proven production ordering: numbers first establish the map
	// band; basket detection then uses that bound. The only semantic change here
	// is that number TemplateScale is never reused as canonical UiScalePx.
	reportCourseProgress(request, 'templates', 'OpenCV ready · loading number templates…');
	reportCourseProgress(request, 'numbers', `${pack.holeNumbers.length} templates loaded · matching hole numbers…`);
	const analysisNumbers = detectCalibratedHoleNumberBadges(
		cv,
		{ format: 'gray', widthPx: analysis.width, heightPx: analysis.height, data: analysis.gray },
		pack.holeNumbers
	);
	const sourceScale = 1 / analysis.scale;
	const numberDetection = sourceNumberDetection(analysisNumbers, sourceScale);
	if (!numberDetection.anchor) {
		throw new Error(
			numberDetection.note ??
				'Course tee detection requires a number-badge anchor; basket TemplateScale is not a UiScalePx fallback.'
		);
	}
	const calibration = deriveUDiscCalibration(
		{
			scale: numberDetection.anchor.scale,
			widthPx: numberDetection.anchor.widthPx,
			heightPx: numberDetection.anchor.heightPx
		},
		pack.manifest.calibration.canonicalNumberBadge
	);
	const mapBoundsPx = deriveMapBoundsFromNumbers(numberDetection.candidates, request.heightPx);

	reportCourseProgress(
		request,
		'baskets',
		`${numberDetection.candidates.filter((candidate) => candidate.label !== undefined).length} numbers assigned · detecting baskets…`
	);
	const baskets = await detectBaskets(
		request.bitmap,
		request.widthPx,
		request.heightPx,
		mapBoundsPx
	);

	reportCourseProgress(request, 'tees', `${baskets.length} baskets found · detecting tee pads…`);
	const full = fullResolutionRaster(request.bitmap);
	const tees = detectCalibratedTeePadCandidates(
		cv,
		{ rgba: full.rgba, widthPx: full.width, heightPx: full.height, sourceScale: 1 },
		{ uiScalePx: calibration.uiScalePx, mapBoundsPx }
	);

	const numberBadges = numberDetection.candidates.map((candidate) => ({
		xPx: candidate.xPx,
		yPx: candidate.yPx,
		score: candidate.score,
		holeNumber: candidate.label
	}));
	reportCourseProgress(request, 'grammar', `${tees.length} tees found · matching course grammar…`);
	const grammar = associateCourseGrammar({ numberBadges, tees, baskets });
	return { numberDetection, tees, baskets, grammar };
}

async function processRequest(request: BasketRequest): Promise<void> {
	try {
		if (request.kind === 'prewarm') {
			await Promise.all([loadRuntime(), loadTemplatePack()]);
			(self as unknown as Worker).postMessage({ ok: true, kind: request.kind, token: request.token });
			return;
		}
		if (request.kind === 'detect-course') {
			const course = await detectCourse(request);
			(self as unknown as Worker).postMessage({ ok: true, kind: request.kind, token: request.token, course });
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
		const candidates = await detectBaskets(request.bitmap, request.widthPx, request.heightPx);
		(self as unknown as Worker).postMessage({ ok: true, kind: request.kind, token: request.token, candidates });
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

let queuedWork: Promise<void> = Promise.resolve();
self.onmessage = (event: MessageEvent<BasketRequest>) => {
	const request = event.data;
	queuedWork = queuedWork.then(
		() => processRequest(request),
		() => processRequest(request)
	);
};
