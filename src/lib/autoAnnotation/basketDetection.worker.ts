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
	detectCalibratedTeeGapFallbackCandidates,
	detectCalibratedTeePadCandidates,
	detectCalibratedTeePadVariants,
	findCalibratedBasketAnchorScale
} from './cvCalibratedDetectors';
import type { CalibratedBasketCandidate } from './cvCalibratedDetectors';
import {
	asUiScalePx,
	deriveBasketTemplateScale,
	deriveUDiscCalibration,
	resolveTemplateScale,
	validateCvTemplateManifest
} from './cvCalibration';
import type {
	BasketTemplateScale,
	CvTemplateManifest,
	UiScalePx
} from './cvCalibration';

const MAX_ANALYSIS_DIM = 2200;
// `$app/paths`'s `base` does not resolve inside this worker's separate
// Vite bundle context (it silently resolves to `''` at runtime despite
// compiling cleanly), so the GitHub Pages base path (e.g. `/ChainSpot`)
// must be sent from the main thread with every request instead.
let templateBaseUrl = '/resources/chainspot_cv_templates';

interface BasketDetectionRequest {
	readonly kind: 'detect' | 'detect-course';
	readonly token: string;
	readonly basePath: string;
	readonly bitmap: ImageBitmap;
	readonly widthPx: number;
	readonly heightPx: number;
}

interface BasketPrewarmRequest {
	readonly kind: 'prewarm';
	readonly token: string;
	readonly basePath: string;
}

interface TeeDetectionRequest {
	readonly kind: 'detect-tees';
	readonly token: string;
	readonly basePath: string;
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

interface BasketDetectionTiming {
	rasterMs: number;
	anchorMs: number;
	candidatesMs: number;
	anchorScaleEvaluations: number;
}

function emptyBasketDetectionTiming(): BasketDetectionTiming {
	return { rasterMs: 0, anchorMs: 0, candidatesMs: 0, anchorScaleEvaluations: 0 };
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
	const url = `${templateBaseUrl}/${fileName}`;
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
	templatePackPromise = fetch(`${templateBaseUrl}/manifest.json`)
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
	mapBoundsPx?: { topPx: number; bottomPx: number },
	basketTemplateScale?: BasketTemplateScale,
	timing?: BasketDetectionTiming
): Promise<readonly CalibratedBasketCandidate[]> {
	const [cv, pack] = await Promise.all([loadRuntime(), loadTemplatePack()]);

	const rasterStartedAt = performance.now();
	const full = fullResolutionRaster(bitmap);
	const raster = {
		gray: grayscaleRgba(full.rgba, full.width * full.height),
		widthPx: full.width,
		heightPx: full.height,
		sourceScale: 1
	};
	if (timing) timing.rasterMs = performance.now() - rasterStartedAt;

	let resolvedBasketTemplateScale = basketTemplateScale;
	if (!resolvedBasketTemplateScale) {
		const anchorStartedAt = performance.now();
		const anchor = findCalibratedBasketAnchorScale(
			cv,
			raster,
			pack.basket,
			timing
				? {
						onProgress: () => {
							timing.anchorScaleEvaluations += 1;
						}
					}
				: {}
		);
		if (timing) timing.anchorMs = performance.now() - anchorStartedAt;
		resolvedBasketTemplateScale = anchor?.scale;
	}
	if (!resolvedBasketTemplateScale) return [];

	const candidatesStartedAt = performance.now();
	const candidates = detectBasketCandidatesAtTemplateScale(cv, raster, pack.basket, {
		templateScale: resolvedBasketTemplateScale,
		mapBoundsPx
	}).map((candidate) => ({
		...candidate,
		xPx: Math.max(0, Math.min(widthPx, candidate.xPx)),
		yPx: Math.max(0, Math.min(heightPx, candidate.yPx))
	}));
	if (timing) timing.candidatesMs = performance.now() - candidatesStartedAt;
	return candidates;
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
	message: string,
	elapsedMs?: number
): void {
	(self as unknown as Worker).postMessage({
		ok: true,
		kind: 'progress',
		token: request.token,
		progress: { stage, message, elapsedMs }
	});
}

async function detectCourse(request: BasketDetectionRequest) {
	const startedAt = performance.now();
	const runtimeCachedAtStart = runtimePromise !== null;
	const templatePackCachedAtStart = templatePackPromise !== null;
	const elapsedMs = () => performance.now() - startedAt;

	reportCourseProgress(
		request,
		'opencv',
		'Loading OpenCV runtime and CV calibration manifest…',
		elapsedMs()
	);
	const bootstrapStartedAt = performance.now();
	const [cv, pack] = await Promise.all([loadRuntime(), loadTemplatePack()]);
	const bootstrapMs = performance.now() - bootstrapStartedAt;

	const analysisStartedAt = performance.now();
	const analysis = grayscaleRaster(request.bitmap);
	const analysisRasterMs = performance.now() - analysisStartedAt;

	// Preserve the proven production ordering and detector behavior. This pass
	// only measures where wall-clock time is being spent.
	reportCourseProgress(
		request,
		'templates',
		'OpenCV ready · loading number templates…',
		elapsedMs()
	);
	reportCourseProgress(
		request,
		'numbers',
		`${pack.holeNumbers.length} templates loaded · matching hole numbers…`,
		elapsedMs()
	);
	const numbersStartedAt = performance.now();
	const analysisNumbers = detectCalibratedHoleNumberBadges(
		cv,
		{ format: 'gray', widthPx: analysis.width, heightPx: analysis.height, data: analysis.gray },
		pack.holeNumbers
	);
	const numbersMs = performance.now() - numbersStartedAt;
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
	// `numberDetection.anchor.scale` is deliberately left un-multiplied by
	// `sourceScale` above (see `sourceNumberDetection`) -- it is only correct
	// for glyph matching within the downscaled analysis raster it was
	// measured on. Basket detection below runs against the full-resolution
	// source raster (`sourceScale: 1`), so the anchor scale must be resolved
	// into source space first, or the basket search window ends up centered
	// on the wrong multiplier (measured: 1.073 instead of ~1.81 on the demo
	// fixture -- 53% short, outside the detector's own ±10% search window).
	const basketTemplateScale = deriveBasketTemplateScale(
		resolveTemplateScale({ value: numberDetection.anchor.scale, space: 'analysis' }, 'source', sourceScale),
		pack.manifest.calibration
	);
	const mapBoundsPx = deriveMapBoundsFromNumbers(numberDetection.candidates, request.heightPx);

	reportCourseProgress(
		request,
		'baskets',
		`${numberDetection.candidates.filter((candidate) => candidate.label !== undefined).length} numbers assigned · detecting baskets…`,
		elapsedMs()
	);
	const basketTiming = emptyBasketDetectionTiming();
	const basketsStartedAt = performance.now();
	const baskets = await detectBaskets(
		request.bitmap,
		request.widthPx,
		request.heightPx,
		mapBoundsPx,
		basketTemplateScale,
		basketTiming
	);
	const basketsMs = performance.now() - basketsStartedAt;

	reportCourseProgress(
		request,
		'tees',
		`${baskets.length} baskets found · detecting tee pads…`,
		elapsedMs()
	);
	const teesStartedAt = performance.now();
	const teeRasterStartedAt = performance.now();
	const full = fullResolutionRaster(request.bitmap);
	const teeRasterMs = performance.now() - teeRasterStartedAt;
	const teeDetectionStartedAt = performance.now();
	const tees = detectCalibratedTeePadCandidates(
		cv,
		{ rgba: full.rgba, widthPx: full.width, heightPx: full.height, sourceScale: 1 },
		{ uiScalePx: calibration.uiScalePx, mapBoundsPx }
	);
	const teeDetectionMs = performance.now() - teeDetectionStartedAt;
	const teesMs = performance.now() - teesStartedAt;

	const numberBadges = numberDetection.candidates.map((candidate) => ({
		xPx: candidate.xPx,
		yPx: candidate.yPx,
		score: candidate.score,
		holeNumber: candidate.label
	}));
	reportCourseProgress(
		request,
		'grammar',
		`${tees.length} tees found · matching course grammar…`,
		elapsedMs()
	);
	const grammarStartedAt = performance.now();
	const primaryGrammar = associateCourseGrammar({ numberBadges, tees, baskets });

	// A hole whose tee ownership survives with low confidence typically means
	// no primary (`gray-center`/`edge-loop`) candidate was ever found near its
	// badge -- e.g. a bright dashed putting-circle stroke crossing the pad.
	// Recover those specific badges with a tightly-scoped `occluded-edge-loop`
	// fallback and re-associate once more; every other hole is untouched.
	const gappedBadges = primaryGrammar.holes
		.filter((hole) => hole.tee && hole.tee.confidence < 0.5 && hole.numberBadge)
		.map((hole) => ({ xPx: hole.numberBadge!.xPx, yPx: hole.numberBadge!.yPx }));
	const gapFallbackStartedAt = performance.now();
	const gapFallbackCandidates = gappedBadges.length
		? detectCalibratedTeeGapFallbackCandidates(
				cv,
				{ rgba: full.rgba, widthPx: full.width, heightPx: full.height, sourceScale: 1 },
				{ uiScalePx: calibration.uiScalePx, mapBoundsPx },
				gappedBadges
			)
		: [];
	const gapFallbackMs = performance.now() - gapFallbackStartedAt;
	const finalTees = gapFallbackCandidates.length ? [...tees, ...gapFallbackCandidates] : tees;
	const grammar = gapFallbackCandidates.length
		? associateCourseGrammar({ numberBadges, tees: finalTees, baskets })
		: primaryGrammar;
	const grammarMs = performance.now() - grammarStartedAt;

	const performanceReport = {
		totalMs: elapsedMs(),
		cachedAtStart: {
			runtime: runtimeCachedAtStart,
			templatePack: templatePackCachedAtStart
		},
		input: {
			sourceWidthPx: request.widthPx,
			sourceHeightPx: request.heightPx,
			analysisWidthPx: analysis.width,
			analysisHeightPx: analysis.height,
			analysisScale: analysis.scale
		},
		stages: {
			bootstrapMs,
			analysisRasterMs,
			numbersMs,
			basketsMs,
			basketRasterMs: basketTiming.rasterMs,
			basketAnchorMs: basketTiming.anchorMs,
			basketCandidatesMs: basketTiming.candidatesMs,
			teesMs,
			teeRasterMs,
			teeDetectionMs,
			gapFallbackMs,
			grammarMs
		},
		counts: {
			numberTemplates: pack.holeNumbers.length,
			numberCandidates: numberDetection.candidates.length,
			labeledNumbers: numberDetection.candidates.filter((candidate) => candidate.label !== undefined).length,
			baskets: baskets.length,
			tees: finalTees.length,
			basketAnchorScaleEvaluations: basketTiming.anchorScaleEvaluations,
			gappedBadges: gappedBadges.length,
			gapFallbackCandidates: gapFallbackCandidates.length
		},
		calibration: {
			numberTemplateScale: numberDetection.anchor.scale,
			basketTemplateScale,
			basketTemplateScalePerNumberTemplateScale:
				basketTemplateScale / numberDetection.anchor.scale
		}
	};

	return { numberDetection, tees: finalTees, baskets, grammar, performance: performanceReport };
}

async function processRequest(request: BasketRequest): Promise<void> {
	templateBaseUrl = `${request.basePath}/resources/chainspot_cv_templates`;
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
