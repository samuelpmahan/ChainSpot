import { loadCv } from '../stitch/cvMatch';
import { associateCourseGrammar, deriveBasketPolarityPenaltyPx } from './courseGrammar';
import {
	labelKnownHoleNumberBadges,
	type HoleNumberCvModule,
	type HoleNumberTemplate
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
	detectCalibratedBasketOcclusionFallback,
	detectCalibratedHoleNumberBadges,
	detectWorldNormalizedTeeBootstrap,
	detectCalibratedTeePadCandidates,
	detectCalibratedTeePadVariants,
	findCalibratedBasketAnchorScale
} from './cvCalibratedDetectors';
import type { CalibratedBasketCandidate } from './cvCalibratedDetectors';
import {
	basketRecoverySamplesFromGrammar,
	deriveBasketDistanceBand,
	findUnresolvedBasketHoles,
	isSameBasketCandidate
} from './basketOcclusionRecovery';
import {
	asNumberTemplateScale,
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
import { localFeatureSnap } from '../cv/localSnap';
import type { LocalSnapCalibration, LocalSnapKind, LocalSnapPoint, LocalSnapRaster } from '../cv/localSnap';
import { detectRawObjectMask, RAW_MASK_HISTORICAL_DEFAULTS } from './rawObjectMask';
import { deriveP3Ownership } from './rawObjectOwnership';
import { deriveP4RibbonOwnership } from './p4RibbonOwnership';
import { DEFAULT_RIBBON_MASS_PARAMS, segmentRibbonMass } from './ribbonMass';
import { deriveP5SparseAssignment } from './p5SparseAssignment';
import { deriveP6LowParBasketAssignment } from './p6LowParBasketAssignment';
import { buildPancakeDisplayGrammar } from './pancakeCourseDisplay';
import { deriveMiddleOutDiagnostics, type MiddleOutCv } from './middleOutRibbon';
import type { VisionFlags } from './visionFlags';
import { classifyKnownBadgeBodiesPureTs } from './badgeGlyphClassifier';
import {
	COURSE_VISION_OPERATORS,
	operatorLabel,
	type CourseVisionEvidenceEvent,
	type EvidenceHoleGeometry,
	type EvidenceLandmark
} from './courseVisionEvidence';

const MAX_ANALYSIS_DIM = 4096;
// TEMP DEV ONLY: benchmark Pancake 1-3 without paying for legacy ownership CV.
const PANCAKE_STACK_ONLY = true;
// `$app/paths`'s `base` does not resolve inside this worker's separate
// Vite bundle context (it silently resolves to `''` at runtime despite
// compiling cleanly), so the GitHub Pages base path (e.g. `/ChainSpot`)
// must be sent from the main thread with every request instead.
let templateBaseUrl = '/resources/chainspot_cv_templates';

interface BasketDetectionRequest {
	readonly kind: 'detect';
	readonly token: string;
	readonly basePath: string;
	readonly bitmap: ImageBitmap;
	readonly widthPx: number;
	readonly heightPx: number;
}

interface CourseDetectionRequest {
	readonly kind: 'detect-course';
	readonly token: string;
	readonly basePath: string;
	readonly bitmap: ImageBitmap;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly visionFlags?: VisionFlags;
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

/**
 * "Snap-to-detection" (see `localSnap.ts`'s doc comment for why this reuses
 * the worker rather than a second main-thread OpenCV instance). The caller
 * forwards its already-known number-badge anchor (the same one
 * `detectCourse`/`detectTees` derive `UiScalePx`/`BasketTemplateScale` from)
 * as raw numbers rather than a branded type -- branding only matters once
 * this worker re-derives calibration from it, structured-clone doesn't care.
 */
interface LocalSnapRequest {
	readonly kind: 'local-snap';
	readonly token: string;
	readonly basePath: string;
	readonly bitmap: ImageBitmap;
	readonly snapKind: LocalSnapKind;
	readonly clickPx: LocalSnapPoint;
	readonly numberAnchor: { scale: number; widthPx: number; heightPx: number };
}

type BasketRequest =
	| BasketDetectionRequest
	| CourseDetectionRequest
	| BasketPrewarmRequest
	| TeeDetectionRequest
	| LocalSnapRequest;
type RuntimeCv = BasketCv & TeePadCv & HoleNumberCvModule & MiddleOutCv;

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

/**
 * "Snap-to-detection" (design point 1/2). Re-derives `UiScalePx` (and, for a
 * basket snap, `BasketTemplateScale`) from the caller's own number-badge
 * anchor exactly the way `detectCourse` does, then hands the *whole*
 * full-resolution raster to `localFeatureSnap`, which does its own
 * cropping down to a small window around the click before running any
 * detector -- see that module's doc comment for why decoding the whole
 * image here (rather than a canvas-level partial draw) was an acceptable
 * trade-off given this request is always wrapped in the caller's optimistic
 * placement.
 */
async function detectLocalSnap(request: LocalSnapRequest): Promise<LocalSnapPoint | null> {
	const [cv, pack] = await Promise.all([loadRuntime(), loadTemplatePack()]);
	const numberTemplateScale = asNumberTemplateScale(request.numberAnchor.scale, 'Local snap number anchor scale');
	const calibration = deriveUDiscCalibration(
		{ scale: numberTemplateScale, widthPx: request.numberAnchor.widthPx, heightPx: request.numberAnchor.heightPx },
		pack.manifest.calibration.canonicalNumberBadge
	);

	const full = fullResolutionRaster(request.bitmap);
	const raster: LocalSnapRaster =
		request.snapKind === 'tee'
			? { rgba: full.rgba, widthPx: full.width, heightPx: full.height, sourceScale: 1 }
			: {
					gray: grayscaleRgba(full.rgba, full.width * full.height),
					widthPx: full.width,
					heightPx: full.height,
					sourceScale: 1
				};

	const localSnapCalibration: LocalSnapCalibration =
		request.snapKind === 'basket'
			? {
					uiScalePx: calibration.uiScalePx,
					basket: {
						template: pack.basket,
						templateScale: deriveBasketTemplateScale(numberTemplateScale, pack.manifest.calibration)
					}
				}
			: { uiScalePx: calibration.uiScalePx };

	return localFeatureSnap(request.snapKind, cv, raster, request.clickPx, localSnapCalibration);
}

function reportCourseProgress(
	request: CourseDetectionRequest,
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

/**
 * Sibling to `reportCourseProgress` for progressive Course Vision evidence
 * (stage `'evidence'`, see `courseVisionEvidence.ts`). A batch of events
 * rides one postMessage. Never throws -- a failure here must never break
 * detection, so this posts on a best-effort basis only.
 */
function reportCourseEvidence(
	request: CourseDetectionRequest,
	events: readonly CourseVisionEvidenceEvent[],
	elapsedMs: number
): void {
	if (events.length === 0) return;
	try {
		(self as unknown as Worker).postMessage({
			ok: true,
			kind: 'progress',
			token: request.token,
			progress: {
				stage: 'evidence',
				message: `Course Vision evidence: ${events.length} update${events.length === 1 ? '' : 's'}`,
				elapsedMs,
				evidence: events
			}
		});
	} catch (error) {
		console.warn('[ChainSpot NuThing fast lane] evidence postMessage failed.', error);
	}
}

async function detectCourse(request: CourseDetectionRequest) {
	// The main thread snapshots flags at request creation. Never consult
	// storage/global state here: one worker request must remain internally stable.
	const visionFlags: VisionFlags = Object.freeze({
		zeroBendShortcutEnabled: request.visionFlags?.zeroBendShortcutEnabled ?? true,
		zeroBendMaxDistancePx: request.visionFlags?.zeroBendMaxDistancePx === 4 ? 4 : 3,
		p1Profile: request.visionFlags?.p1Profile === 'historical' ? 'historical' : 'tuned'
	});
	const p1Tuning = visionFlags.p1Profile === 'historical' ? RAW_MASK_HISTORICAL_DEFAULTS : undefined;
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
	// NuThing fast lane: kick off bootstrap without blocking on it. Both loaders
	// are module-scope memoized, so this is safe to call again below without
	// duplicating work. The `.catch(() => {})` guards exist ONLY to suppress
	// unhandled-rejection noise if the fast lane below fails before its own
	// awaits reach these promises -- the real awaits later still surface errors.
	const bootstrapKickoffAt = performance.now();
	const runtimeReady = loadRuntime();
	const packReady = loadTemplatePack();
	runtimeReady.catch(() => {});
	packReady.catch(() => {});

	if (PANCAKE_STACK_ONLY) {
		const fullRasterStartedAt = performance.now();
		const full = fullResolutionRaster(request.bitmap);
		const fullRasterMs = performance.now() - fullRasterStartedAt;

		const p1MaskStartedAt = performance.now();
		const rawMaskObjects = detectRawObjectMask(
			{ rgba: full.rgba, widthPx: full.width, heightPx: full.height },
			undefined,
			p1Tuning
		);
		const p1MaskMs = performance.now() - p1MaskStartedAt;
		const bootstrapKickoffToP1CompleteMs = performance.now() - bootstrapKickoffAt;

		// NuThing fast lane, step 2: emit a `candidate` batch for everything P1
		// just localized, before any identity exists.
		try {
			const candidateLandmarks = (items: readonly { xPx: number; yPx: number; widthPx: number; heightPx: number }[]): readonly EvidenceLandmark[] =>
				items.map((item) => ({ xPx: item.xPx, yPx: item.yPx, widthPx: item.widthPx, heightPx: item.heightPx }));
			reportCourseEvidence(
				request,
				[
					{
						state: 'candidate',
						channel: 'fast-lane',
						producer: COURSE_VISION_OPERATORS.rawUiLandmarkLocalization,
						landmarks: {
							tees: candidateLandmarks(rawMaskObjects.tees),
							badges: candidateLandmarks(rawMaskObjects.badges),
							// RawMaskBasket's xPx/yPx is the display point (sprite
							// bottom), distinct from centerXPx/centerYPx -- see
							// rawObjectMask.ts.
							baskets: candidateLandmarks(rawMaskObjects.baskets)
						},
						message: `${operatorLabel(COURSE_VISION_OPERATORS.rawUiLandmarkLocalization)} found ${rawMaskObjects.tees.length} tee, ${rawMaskObjects.badges.length} badge, ${rawMaskObjects.baskets.length} basket candidates`,
						elapsedMs: elapsedMs()
					}
				],
				elapsedMs()
			);
		} catch (error) {
			console.warn('[ChainSpot NuThing fast lane] candidate evidence emission failed.', error);
		}

		// NuThing fast lane, steps 3-4: pure-TS badge identity + geometric
		// ownership, run purely for early evidence. A failure here must never
		// break detection -- the authoritative chain below is untouched by
		// anything in this block.
		let fastLaneTemplatePackReadyMs = 0;
		let fastLanePureTsBadgeClassifyMs = 0;
		let fastLanePureTsConfidentLabels = 0;
		let fastLanePureTsAbstentions = 0;
		let fastLaneP3Ms = 0;
		let fastLaneOwnedHoles = 0;
		let fastLaneProvisionalHoles = 0;
		try {
			const fastPack = await packReady;
			fastLaneTemplatePackReadyMs = elapsedMs();

			const pureTsStartedAt = performance.now();
			const classifications = classifyKnownBadgeBodiesPureTs(
				{ data: full.rgba, widthPx: full.width, heightPx: full.height },
				fastPack.holeNumbers,
				rawMaskObjects.badges
			);
			fastLanePureTsBadgeClassifyMs = performance.now() - pureTsStartedAt;

			const confident = classifications.filter(
				(classification): classification is typeof classification & { label: number } =>
					classification.label !== undefined
			);
			fastLanePureTsConfidentLabels = confident.length;
			fastLanePureTsAbstentions = classifications.length - confident.length;

			const fastLaneLabeledBadges = confident.map((classification) => {
				const badge = rawMaskObjects.badges[classification.badgeIndex];
				return {
					holeNumber: classification.label,
					glyphScore: classification.bestScore,
					xPx: badge.xPx,
					yPx: badge.yPx,
					widthPx: badge.widthPx,
					heightPx: badge.heightPx
				};
			});

			if (fastLaneLabeledBadges.length > 0) {
				reportCourseEvidence(
					request,
					fastLaneLabeledBadges.map((badge) => ({
						state: 'identified',
						channel: 'fast-lane',
						producer: COURSE_VISION_OPERATORS.pureTsBadgeGlyphIdentification,
						holeNumber: badge.holeNumber,
						geometry: {
							badge: { xPx: badge.xPx, yPx: badge.yPx, widthPx: badge.widthPx, heightPx: badge.heightPx }
						},
						message: `${operatorLabel(COURSE_VISION_OPERATORS.pureTsBadgeGlyphIdentification)} resolved H${badge.holeNumber}`,
						elapsedMs: elapsedMs()
					})),
					elapsedMs()
				);

				const p3StartedAt = performance.now();
				const fastLaneP3Ownership = deriveP3Ownership(
					rawMaskObjects.tees,
					fastLaneLabeledBadges,
					rawMaskObjects.baskets,
					visionFlags
				);
				fastLaneP3Ms = performance.now() - p3StartedAt;
				fastLaneOwnedHoles = fastLaneP3Ownership.teeBadgeHits.length;
				fastLaneProvisionalHoles = fastLaneP3Ownership.straightBasketHits.length;

				const badgeByHoleNumber = new Map(fastLaneLabeledBadges.map((badge) => [badge.holeNumber, badge]));
				const ownedEvents: CourseVisionEvidenceEvent[] = fastLaneP3Ownership.teeBadgeHits.map((hit) => {
					const tee = rawMaskObjects.tees[hit.teeIndex];
					const badge = badgeByHoleNumber.get(hit.holeNumber);
					const geometry: EvidenceHoleGeometry = {
						tee: { xPx: tee.xPx, yPx: tee.yPx, widthPx: tee.widthPx, heightPx: tee.heightPx },
						...(badge ? { badge: { xPx: badge.xPx, yPx: badge.yPx, widthPx: badge.widthPx, heightPx: badge.heightPx } } : {})
					};
					return {
						state: 'owned',
						channel: 'fast-lane',
						producer: COURSE_VISION_OPERATORS.geometricOwnership,
						holeNumber: hit.holeNumber,
						geometry,
						message: `${operatorLabel(COURSE_VISION_OPERATORS.geometricOwnership)} owns H${hit.holeNumber}`,
						elapsedMs: elapsedMs()
					};
				});
				const provisionalEvents: CourseVisionEvidenceEvent[] = fastLaneP3Ownership.straightBasketHits.map((hit) => {
					const tee = rawMaskObjects.tees[hit.teeIndex];
					const badge = badgeByHoleNumber.get(hit.holeNumber);
					const basket = rawMaskObjects.baskets[hit.basketIndex];
					const geometry: EvidenceHoleGeometry = {
						tee: { xPx: tee.xPx, yPx: tee.yPx, widthPx: tee.widthPx, heightPx: tee.heightPx },
						...(badge ? { badge: { xPx: badge.xPx, yPx: badge.yPx, widthPx: badge.widthPx, heightPx: badge.heightPx } } : {}),
						basket: { xPx: basket.xPx, yPx: basket.yPx, widthPx: basket.widthPx, heightPx: basket.heightPx }
					};
					return {
						state: 'provisional',
						channel: 'fast-lane',
						producer: COURSE_VISION_OPERATORS.geometricOwnership,
						holeNumber: hit.holeNumber,
						geometry,
						message: `${operatorLabel(COURSE_VISION_OPERATORS.geometricOwnership)} found provisional straight evidence for H${hit.holeNumber}`,
						elapsedMs: elapsedMs()
					};
				});
				reportCourseEvidence(request, [...ownedEvents, ...provisionalEvents], elapsedMs());
			}
		} catch (error) {
			console.warn('[ChainSpot NuThing fast lane] pure-TS badge identity/ownership failed.', error);
		}

		// Authoritative chain from here on: byte-identical calls, order, inputs,
		// and return object to the pre-fast-lane version. `cv`/`pack` are
		// awaited here (not kicked off again -- both loaders are memoized) so
		// bootstrapMs keeps its old meaning: bootstrap kickoff until both are
		// ready.
		const [cv, pack] = await Promise.all([runtimeReady, packReady]);
		const bootstrapMs = performance.now() - bootstrapKickoffAt;
		const opencvReadyMs = elapsedMs();

		const p2BadgeLabelStartedAt = performance.now();
		const p2BadgeDetectionRaw = labelKnownHoleNumberBadges(
			cv,
			{ format: 'rgba', widthPx: full.width, heightPx: full.height, data: full.rgba },
			pack.holeNumbers,
			rawMaskObjects.badges
		);
		const p2BadgeDetection = {
			...p2BadgeDetectionRaw,
			anchor: p2BadgeDetectionRaw.anchor
				? { ...p2BadgeDetectionRaw.anchor, scale: asNumberTemplateScale(p2BadgeDetectionRaw.anchor.scale) }
				: null,
			candidates: p2BadgeDetectionRaw.candidates.map((candidate) => ({
				...candidate,
				scale: asNumberTemplateScale(candidate.scale)
			}))
		};
		const p2BadgeLabelMs = performance.now() - p2BadgeLabelStartedAt;
		const p2LabeledBadges = p2BadgeDetection.candidates
			.filter((candidate): candidate is typeof candidate & { label: number; glyphScore: number } =>
				candidate.label !== undefined && candidate.glyphScore !== undefined
			)
			.map((candidate) => ({
				holeNumber: candidate.label,
				glyphScore: candidate.glyphScore,
				xPx: candidate.xPx,
				yPx: candidate.yPx,
				widthPx: candidate.widthPx,
				heightPx: candidate.heightPx
			}));

		try {
			reportCourseEvidence(
				request,
				p2LabeledBadges.map((badge) => ({
					state: 'identified',
					channel: 'authoritative',
					producer: COURSE_VISION_OPERATORS.badgeGlyphIdentification,
					holeNumber: badge.holeNumber,
					geometry: {
						badge: { xPx: badge.xPx, yPx: badge.yPx, widthPx: badge.widthPx, heightPx: badge.heightPx }
					},
					message: `${operatorLabel(COURSE_VISION_OPERATORS.badgeGlyphIdentification)} resolved H${badge.holeNumber}`,
					elapsedMs: elapsedMs()
				})),
				elapsedMs()
			);
		} catch (error) {
			console.warn('[ChainSpot Course Vision evidence] authoritative P2 evidence emission failed.', error);
		}

		const p3StartedAt = performance.now();
		const p3Ownership = deriveP3Ownership(
			rawMaskObjects.tees,
			p2LabeledBadges,
			rawMaskObjects.baskets,
			visionFlags
		);
		const p3Ms = performance.now() - p3StartedAt;

		try {
			const authoritativeBadgeByHoleNumber = new Map(p2LabeledBadges.map((badge) => [badge.holeNumber, badge]));
			const ownedEvents: CourseVisionEvidenceEvent[] = p3Ownership.teeBadgeHits.map((hit) => {
				const tee = rawMaskObjects.tees[hit.teeIndex];
				const badge = authoritativeBadgeByHoleNumber.get(hit.holeNumber);
				const geometry: EvidenceHoleGeometry = {
					tee: { xPx: tee.xPx, yPx: tee.yPx, widthPx: tee.widthPx, heightPx: tee.heightPx },
					...(badge ? { badge: { xPx: badge.xPx, yPx: badge.yPx, widthPx: badge.widthPx, heightPx: badge.heightPx } } : {})
				};
				return {
					state: 'owned',
					channel: 'authoritative',
					producer: COURSE_VISION_OPERATORS.geometricOwnership,
					holeNumber: hit.holeNumber,
					geometry,
					message: `${operatorLabel(COURSE_VISION_OPERATORS.geometricOwnership)} owns H${hit.holeNumber}`,
					elapsedMs: elapsedMs()
				};
			});
			const provisionalEvents: CourseVisionEvidenceEvent[] = p3Ownership.straightBasketHits.map((hit) => {
				const tee = rawMaskObjects.tees[hit.teeIndex];
				const badge = authoritativeBadgeByHoleNumber.get(hit.holeNumber);
				const basket = rawMaskObjects.baskets[hit.basketIndex];
				const geometry: EvidenceHoleGeometry = {
					tee: { xPx: tee.xPx, yPx: tee.yPx, widthPx: tee.widthPx, heightPx: tee.heightPx },
					...(badge ? { badge: { xPx: badge.xPx, yPx: badge.yPx, widthPx: badge.widthPx, heightPx: badge.heightPx } } : {}),
					basket: { xPx: basket.xPx, yPx: basket.yPx, widthPx: basket.widthPx, heightPx: basket.heightPx }
				};
				return {
					state: 'provisional',
					channel: 'authoritative',
					producer: COURSE_VISION_OPERATORS.geometricOwnership,
					holeNumber: hit.holeNumber,
					geometry,
					message: `${operatorLabel(COURSE_VISION_OPERATORS.geometricOwnership)} found provisional straight evidence for H${hit.holeNumber}`,
					elapsedMs: elapsedMs()
				};
			});
			reportCourseEvidence(request, [...ownedEvents, ...provisionalEvents], elapsedMs());
		} catch (error) {
			console.warn('[ChainSpot Course Vision evidence] authoritative P3 evidence emission failed.', error);
		}

		// Ribbon segmentation is the expensive shared input to both P4 and
		// P6.2's ribbon-distance evidence. Run it exactly once here and pass
		// the same segmentation object to both — neither stage segments the
		// raster itself. (P4.5's endpoint-bridge experiment was a negative
		// result — see p4RibbonOwnership.ts — and no longer runs in this path.)
		const ribbonSegmentationStartedAt = performance.now();
		const ribbonSegmentation = segmentRibbonMass(
			{ data: full.rgba, widthPx: full.width, heightPx: full.height, channels: 4 },
			p2LabeledBadges.map((badge) => ({ xPx: badge.xPx, yPx: badge.yPx })),
			DEFAULT_RIBBON_MASS_PARAMS
		);
		const ribbonSegmentationMs = performance.now() - ribbonSegmentationStartedAt;
		// Structurally guaranteed by the single segmentRibbonMass call site above.
		const ribbonSegmentationRuns = 1;

		const p4StartedAt = performance.now();
		const p4RibbonOwnership = deriveP4RibbonOwnership(
			ribbonSegmentation,
			rawMaskObjects.tees,
			p2LabeledBadges,
			rawMaskObjects.baskets,
			p3Ownership
		);
		const p4Ms = performance.now() - p4StartedAt;

		const p5StartedAt = performance.now();
		const p5SparseAssignment = deriveP5SparseAssignment(
			rawMaskObjects.tees,
			p2LabeledBadges,
			p3Ownership,
			p4RibbonOwnership
		);
		const p5Ms = performance.now() - p5StartedAt;

		const p6StartedAt = performance.now();
		const p6LowParBasketAssignment = deriveP6LowParBasketAssignment(
			{
				data: full.rgba,
				widthPx: full.width,
				heightPx: full.height,
				originXPx: 0,
				originYPx: 0,
				scale: 1,
				channels: 4
			},
			rawMaskObjects.tees,
			rawMaskObjects.baskets,
			p2LabeledBadges,
			p5SparseAssignment,
			p4RibbonOwnership,
			ribbonSegmentation,
			visionFlags
		);
		const p6Ms = performance.now() - p6StartedAt;

		const middleOutStartedAt = performance.now();
		let middleOut: ReturnType<typeof deriveMiddleOutDiagnostics> | undefined;
		try {
			middleOut = deriveMiddleOutDiagnostics(
				cv,
				{
					data: full.rgba,
					widthPx: full.width,
					heightPx: full.height,
					originXPx: 0,
					originYPx: 0,
					scale: 1,
					channels: 4
				},
				rawMaskObjects.tees,
				rawMaskObjects.baskets,
				p2LabeledBadges,
				p5SparseAssignment,
				p6LowParBasketAssignment
			);
		} catch (error) {
			console.warn('[ChainSpot MiddleOut] diagnostic failed; preserving P1→P6 course detection.', error);
		}
		const middleOutMs = performance.now() - middleOutStartedAt;

		const numberTemplateScale = p2BadgeDetection.anchor?.scale ?? asNumberTemplateScale(1);
		const basketTemplateScale = deriveBasketTemplateScale(numberTemplateScale, pack.manifest.calibration);
		const performanceReport = {
			totalMs: elapsedMs(),
			ribbonSegmentationRuns,
			cachedAtStart: {
				runtime: runtimeCachedAtStart,
				templatePack: templatePackCachedAtStart
			},
			input: {
				sourceWidthPx: request.widthPx,
				sourceHeightPx: request.heightPx,
				analysisWidthPx: full.width,
				analysisHeightPx: full.height,
				analysisScale: 1
			},
			stages: {
				bootstrapMs,
				analysisRasterMs: 0,
				numbersMs: 0,
				basketsMs: 0,
				basketRasterMs: 0,
				basketAnchorMs: 0,
				basketCandidatesMs: 0,
				p1MaskMs,
				p2BadgeLabelMs,
				p3Ms,
				ribbonSegmentationMs,
				p4Ms,
				p5Ms,
				p6Ms,
				middleOutMs,
				teesMs: 0,
				teeRasterMs: fullRasterMs,
				teeDetectionMs: 0,
				basketFallbackMs: 0,
				grammarMs: 0
			},
			counts: {
				numberTemplates: pack.holeNumbers.length,
				numberCandidates: p2BadgeDetection.candidates.length,
				labeledNumbers: p2LabeledBadges.length,
				baskets: rawMaskObjects.baskets.length,
				tees: rawMaskObjects.tees.length,
				p1MaskTees: rawMaskObjects.tees.length,
				p1MaskBadges: rawMaskObjects.badges.length,
				p1MaskBaskets: rawMaskObjects.baskets.length,
				p2LabeledBadges: p2LabeledBadges.length,
				p2UniqueLabels: new Set(p2LabeledBadges.map((badge) => badge.holeNumber)).size,
				p3OwnedTees: p3Ownership.teeBadgeHits.length,
				p3StraightBasketHits: p3Ownership.straightBasketHits.length,
				p3TeeConflicts: p3Ownership.teeConflictIndexes.length,
				p3StraightBasketConflicts: p3Ownership.straightBasketConflictHoleNumbers.length,
				p4ResolvedTees: p4RibbonOwnership.teeResolutions.filter((resolution) => resolution.status === 'resolved').length,
				p4AmbiguousTees: p4RibbonOwnership.teeResolutions.filter((resolution) => resolution.status === 'ambiguous').length,
				p4NoRibbonSupportTees: p4RibbonOwnership.teeResolutions.filter(
					(resolution) => resolution.status === 'noRibbonSupport'
				).length,
				p4BasketResolved: p4RibbonOwnership.holes.filter((hole) => hole.status === 'basketResolved').length,
				p4BasketAmbiguous: p4RibbonOwnership.holes.filter((hole) => hole.status === 'basketAmbiguous').length,
				p4NoBasket: p4RibbonOwnership.holes.filter((hole) => hole.status === 'noBasket').length,
				p4SharedComponents: p4RibbonOwnership.sharedComponentLabels.length,
				p5AssignedTees: p5SparseAssignment.assignedTees,
				p5UnresolvedTees: p5SparseAssignment.unresolvedTees,
				p6LockedByP4: p6LowParBasketAssignment.lockedByP4,
				p6LockedByZeroBend: p6LowParBasketAssignment.lockedByZeroBend,
				p6AssignedByLowPar: p6LowParBasketAssignment.assignedByLowPar,
				p6Unresolved: p6LowParBasketAssignment.unresolved,
				basketAnchorScaleEvaluations: 0,
				basketFallbackUnresolvedHoles: 0,
				basketFallbackRecovered: 0,
				teeBootstrapAuto: 0,
				teeBootstrapReview: 0,
				teeBootstrapUnresolved: rawMaskObjects.tees.length
			},
			calibration: {
				numberTemplateScale,
				basketTemplateScale,
				basketTemplateScalePerNumberTemplateScale: basketTemplateScale / numberTemplateScale
			},
			fastLane: {
				bootstrapKickoffToP1CompleteMs,
				templatePackReadyMs: fastLaneTemplatePackReadyMs,
				pureTsBadgeClassifyMs: fastLanePureTsBadgeClassifyMs,
				pureTsConfidentLabels: fastLanePureTsConfidentLabels,
				pureTsAbstentions: fastLanePureTsAbstentions,
				fastLaneP3Ms,
				fastLaneOwnedHoles,
				fastLaneProvisionalHoles,
				opencvReadyMs
			}
		};
		const displayGrammar = buildPancakeDisplayGrammar(
			rawMaskObjects,
			p2BadgeDetection,
			p5SparseAssignment,
			p6LowParBasketAssignment
		);

		try {
			reportCourseEvidence(
				request,
				displayGrammar.holes.flatMap((hole): CourseVisionEvidenceEvent[] => {
					if (!hole.tee && !hole.basket) return [];
					const geometry: EvidenceHoleGeometry = {
						...(hole.numberBadge
							? { badge: { xPx: hole.numberBadge.xPx, yPx: hole.numberBadge.yPx } }
							: {}),
						...(hole.tee ? { tee: { xPx: hole.tee.xPx, yPx: hole.tee.yPx } } : {}),
						...(hole.basket ? { basket: { xPx: hole.basket.xPx, yPx: hole.basket.yPx } } : {})
					};
					return [
						{
							state: 'final',
							channel: 'authoritative',
							producer: COURSE_VISION_OPERATORS.finalCourseGrammarMaterialization,
							holeNumber: hole.number,
							geometry,
							message: `${operatorLabel(COURSE_VISION_OPERATORS.finalCourseGrammarMaterialization)} finalized H${hole.number}`,
							elapsedMs: elapsedMs()
						}
					];
				}),
				elapsedMs()
			);
		} catch (error) {
			console.warn('[ChainSpot Course Vision evidence] final evidence emission failed.', error);
		}

		return {
			numberDetection: p2BadgeDetection,
			tees: [],
			baskets: [],
			grammar: displayGrammar,
			rawMaskObjects,
			p2BadgeDetection,
			p3Ownership,
			p4RibbonOwnership,
			p5SparseAssignment,
			p6LowParBasketAssignment,
			...(middleOut ? { middleOut } : {}),
			performance: performanceReport,
			visionFlags
		};
	}

	// Dead code: PANCAKE_STACK_ONLY is a const `true` above, so this branch
	// never runs. Kept compiling only -- not optimized -- per the NuThing fast
	// lane migration; `cv`/`pack`/`bootstrapMs` used to come from a blocking
	// `Promise.all` before the branch split above.
	const bootstrapStartedAt = performance.now();
	const [cv, pack] = await Promise.all([runtimeReady, packReady]);
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
		pack.holeNumbers,
		// Keep a surplus localization pool. The label solver leaves extras
		// unlabeled; capping physical bodies at exactly 18 lets one dark false
		// body crowd a real badge out on tall stitched captures.
		{ maxCandidates: 24 }
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
	// Hole-number matching runs on the downscaled analysis raster, while basket
	// matching below runs at full source resolution. TemplateScale is a resize
	// multiplier in the raster coordinate space where matching occurs, so move
	// the number-template multiplier into source space before deriving the
	// basket-family multiplier.
	const sourceNumberTemplateScale = resolveTemplateScale(
		{ value: numberDetection.anchor.scale, space: 'analysis' },
		'source',
		sourceScale
	);
	const basketTemplateScale = deriveBasketTemplateScale(
		sourceNumberTemplateScale,
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
	const primaryBaskets = await detectBaskets(
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
		`${primaryBaskets.length} baskets found · detecting tee pads…`,
		elapsedMs()
	);
	const teesStartedAt = performance.now();
	const teeRasterStartedAt = performance.now();
	const full = fullResolutionRaster(request.bitmap);
	const teeRasterMs = performance.now() - teeRasterStartedAt;
	const p1MaskStartedAt = performance.now();
	const rawMaskObjects = detectRawObjectMask(
		{ rgba: full.rgba, widthPx: full.width, heightPx: full.height },
		undefined,
		p1Tuning
	);
	const p1MaskMs = performance.now() - p1MaskStartedAt;

	const p2BadgeLabelStartedAt = performance.now();
	const p2BadgeDetectionRaw = labelKnownHoleNumberBadges(
		cv,
		{ format: 'rgba', widthPx: full.width, heightPx: full.height, data: full.rgba },
		pack.holeNumbers,
		rawMaskObjects.badges
	);
	const p2BadgeDetection = {
		...p2BadgeDetectionRaw,
		anchor: p2BadgeDetectionRaw.anchor
			? { ...p2BadgeDetectionRaw.anchor, scale: asNumberTemplateScale(p2BadgeDetectionRaw.anchor.scale) }
			: null,
		candidates: p2BadgeDetectionRaw.candidates.map((candidate) => ({
			...candidate,
			scale: asNumberTemplateScale(candidate.scale)
		}))
	};
	const p2BadgeLabelMs = performance.now() - p2BadgeLabelStartedAt;
	const p2LabeledBadges = p2BadgeDetection.candidates
		.filter((candidate): candidate is typeof candidate & { label: number; glyphScore: number } =>
			candidate.label !== undefined && candidate.glyphScore !== undefined
		)
		.map((candidate) => ({
			holeNumber: candidate.label,
			glyphScore: candidate.glyphScore,
			xPx: candidate.xPx,
			yPx: candidate.yPx,
			widthPx: candidate.widthPx,
			heightPx: candidate.heightPx
		}));

	const p3StartedAt = performance.now();
	const p3Ownership = deriveP3Ownership(
		rawMaskObjects.tees,
		p2LabeledBadges,
		rawMaskObjects.baskets,
		visionFlags
	);
	const p3Ms = performance.now() - p3StartedAt;

	const teeDetectionStartedAt = performance.now();
	const teeRaster = { rgba: full.rgba, widthPx: full.width, heightPx: full.height, sourceScale: 1 };
	const teeBadges = numberDetection.candidates
		.filter((candidate): candidate is typeof candidate & { label: number } => candidate.label !== undefined)
		.map((candidate) => ({
			holeNumber: candidate.label,
			xPx: candidate.xPx,
			yPx: candidate.yPx,
			widthPx: candidate.widthPx,
			heightPx: candidate.heightPx
		}));
	// World-normalized tee stage: badges/baskets above ran on the native
	// raster (UI chrome detects at native resolution); the tee detector runs
	// in a private canonical workspace resized so pad frames match the tuned
	// regime, with every output mapped back to native pixels. See
	// scripts/cv-probes/white-rect-scale-findings.md for the evidence.
	const teeBootstrap = detectWorldNormalizedTeeBootstrap(
		cv,
		teeRaster,
		{ uiScalePx: calibration.uiScalePx, mapBoundsPx },
		teeBadges,
		primaryBaskets
	);
	const tees = teeBootstrap.candidates;
	const grammarTees = teeBootstrap.assignments.map((assignment) => ({
		...assignment.candidate,
		holeNumber: assignment.holeNumber,
		bootstrapDecision: assignment.decision,
		confidence: assignment.decision === 'auto'
			? Math.max(0.75, assignment.confidence)
			: Math.min(0.49, assignment.confidence),
		// `assignments` is compacted (one entry per resolved hole), not
		// positionally aligned with `tees`/`teeBootstrap.candidates` -- carry
		// the real raw index through explicitly so `associateCourseGrammar`'s
		// reported `candidateIndex` stays a valid index into `tees`, not a
		// position in this compacted array. See `CoursePointCandidate.candidateIndex`.
		candidateIndex: assignment.candidateIndex
	}));
	const teeDetectionMs = performance.now() - teeDetectionStartedAt;
	const teesMs = performance.now() - teesStartedAt;

	const numberBadges = numberDetection.candidates.map((candidate) => ({
		xPx: candidate.xPx,
		yPx: candidate.yPx,
		score: candidate.score,
		holeNumber: candidate.label,
		widthPx: candidate.widthPx,
		heightPx: candidate.heightPx
	}));
	const basketPolarityPenaltyPx = deriveBasketPolarityPenaltyPx(numberBadges, primaryBaskets);
	reportCourseProgress(
		request,
		'grammar',
		`${teeBootstrap.counts.auto} tee AUTO · ${teeBootstrap.counts.review} REVIEW · ${teeBootstrap.counts.unresolved} unresolved · matching course grammar…`,
		elapsedMs()
	);
	const grammarStartedAt = performance.now();
	const primaryGrammar = associateCourseGrammar({ numberBadges, tees: grammarTees, baskets: primaryBaskets, basketPolarityPenaltyPx });

	// Occlusion-tolerant basket recovery. The primary basket detection and
	// this first grammar pass above are both untouched by what follows: this
	// only asks, of holes the pass above already could not place plausibly,
	// whether narrow masked-template evidence exists at that hole's own
	// location -- see `basketOcclusionRecovery.ts`'s module doc comment.
	const basketFallbackStartedAt = performance.now();
	const basketRecoverySamples = basketRecoverySamplesFromGrammar(primaryGrammar.holes);
	const basketDistanceBand = deriveBasketDistanceBand(basketRecoverySamples);
	const unresolvedBasketHoleNumbers = basketDistanceBand
		? findUnresolvedBasketHoles(basketRecoverySamples, basketDistanceBand)
		: new Set<number>();
	let baskets = primaryBaskets;
	let grammar = primaryGrammar;
	let basketFallbackRecoveredCount = 0;
	if (basketDistanceBand && unresolvedBasketHoleNumbers.size > 0) {
		const unresolvedBadges = numberDetection.candidates
			.filter(
				(candidate): candidate is typeof candidate & { label: number } =>
					candidate.label !== undefined && unresolvedBasketHoleNumbers.has(candidate.label)
			)
			.map((candidate) => ({ holeNumber: candidate.label, xPx: candidate.xPx, yPx: candidate.yPx }));
		const occlusionBoxes = numberDetection.candidates.map((candidate) => ({
			xPx: candidate.xPx,
			yPx: candidate.yPx,
			widthPx: candidate.widthPx,
			heightPx: candidate.heightPx
		}));
		const basketFallbackRaster = {
			gray: grayscaleRgba(full.rgba, full.width * full.height),
			widthPx: full.width,
			heightPx: full.height
		};
		const recovered = detectCalibratedBasketOcclusionFallback(
			basketFallbackRaster,
			pack.basket,
			unresolvedBadges,
			occlusionBoxes,
			basketDistanceBand,
			basketTemplateScale
		);
		const nonDuplicateRecovered = recovered.filter(
			(candidate) => !primaryBaskets.some((existing) => isSameBasketCandidate(existing, candidate))
		);
		basketFallbackRecoveredCount = nonDuplicateRecovered.length;
		if (nonDuplicateRecovered.length > 0) {
			baskets = [...primaryBaskets, ...nonDuplicateRecovered];
			const grammarBaskets = [
				...primaryBaskets,
				...nonDuplicateRecovered.map((candidate) => ({ ...candidate, bootstrapDecision: 'review' as const }))
			];
			grammar = associateCourseGrammar({ numberBadges, tees: grammarTees, baskets: grammarBaskets, basketPolarityPenaltyPx });
		}
	}
	const basketFallbackMs = performance.now() - basketFallbackStartedAt;
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
			p1MaskMs,
			p2BadgeLabelMs,
			p3Ms,
			teesMs,
			teeRasterMs,
			teeDetectionMs,
			basketFallbackMs,
			grammarMs
		},
		counts: {
			numberTemplates: pack.holeNumbers.length,
			numberCandidates: numberDetection.candidates.length,
			labeledNumbers: numberDetection.candidates.filter((candidate) => candidate.label !== undefined).length,
			baskets: baskets.length,
			tees: tees.length,
			p1MaskTees: rawMaskObjects.tees.length,
			p1MaskBadges: rawMaskObjects.badges.length,
			p1MaskBaskets: rawMaskObjects.baskets.length,
			p2LabeledBadges: p2LabeledBadges.length,
			p2UniqueLabels: new Set(p2LabeledBadges.map((badge) => badge.holeNumber)).size,
			p3OwnedTees: p3Ownership.teeBadgeHits.length,
			p3StraightBasketHits: p3Ownership.straightBasketHits.length,
			p3TeeConflicts: p3Ownership.teeConflictIndexes.length,
			p3StraightBasketConflicts: p3Ownership.straightBasketConflictHoleNumbers.length,
			basketAnchorScaleEvaluations: basketTiming.anchorScaleEvaluations,
			basketFallbackUnresolvedHoles: unresolvedBasketHoleNumbers.size,
			basketFallbackRecovered: basketFallbackRecoveredCount,
			teeBootstrapAuto: teeBootstrap.counts.auto,
			teeBootstrapReview: teeBootstrap.counts.review,
			teeBootstrapUnresolved: teeBootstrap.counts.unresolved
		},
		calibration: {
			numberTemplateScale: sourceNumberTemplateScale,
			basketTemplateScale,
			basketTemplateScalePerNumberTemplateScale:
				basketTemplateScale / sourceNumberTemplateScale
		}
	};

	return {
		numberDetection,
		tees,
		teeBootstrap,
		baskets,
		grammar,
		rawMaskObjects,
		p2BadgeDetection,
		p3Ownership,
		performance: performanceReport,
		visionFlags
	};
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
		if (request.kind === 'local-snap') {
			const snapped = await detectLocalSnap(request);
			(self as unknown as Worker).postMessage({ ok: true, kind: request.kind, token: request.token, snapped });
			return;
		}
		if (request.kind === 'detect') {
			const candidates = await detectBaskets(request.bitmap, request.widthPx, request.heightPx);
			(self as unknown as Worker).postMessage({ ok: true, kind: request.kind, token: request.token, candidates });
			return;
		}
		const unexpectedRequest: never = request;
		throw new Error(`Unsupported basket detection request: ${String(unexpectedRequest)}`);
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
