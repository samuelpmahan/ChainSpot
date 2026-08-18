/**
 * ChainSpot Stitch Map source-intake pipeline entry point (CHSPT-50/55/56,
 * semantic front-end CHSPT-75..78).
 *
 * One call covers N=1 AutoCrop and N>1 AutoCrop+AutoStitch. N>1 starts the
 * existing OpenCV runtime warm-up and the pure-TS source-landmark scan after
 * crop resolution, then feeds those source landmarks into the existing
 * arbitrary-layout pose graph. Rendering remains exclusively owned by
 * `renderComposite.ts`.
 */
import { isSupportedMimeType, decodeImageFile, readFileBytes, sha256Hex } from '../imageIntake';
import type { DecodedImage, DecodeImageFile, HashBytes } from '../imageIntake';
import { toAnalysisRaster, toCropRaster } from './analysis';
import type { AnalysisRaster, RasterRegion } from './analysis';
import {
	DEFAULT_CROP_SAFETY_MARGIN_PX,
	proposeCropDetailed,
	proposeSingleImageCrop
} from './autoCrop';
import type { CropProposalDetail } from './autoCrop';
import { matcherRegionFromCrop } from './cropGate';
import { findDuplicateRasters, duplicateImageMessage } from './duplicates';
import { WEAK_EDGE_MAX_SCORE } from './diagnostics';
import { ZERO_CROP } from './geometry';
import type { CropInsets } from './geometry';
import { buildPoseGraph, composeAffine6, MAX_POSE_GRAPH_TILES } from './poseGraph';
import type { Affine6Coefficients } from '../geometry/affine6';
import {
	applySourceTransform,
	buildSourceTransform,
	translationSourceTransform,
	AUTO_SOURCE_CAPTURE_ORIGIN,
	CURRENT_PROVENANCE_SCHEMA_VERSION,
	CURRENT_RENDER_VERSION
} from '../domain/provenance';
import type {
	CompositePoint,
	DraftComposite,
	ResamplingMethod,
	SourceCapture,
	SourceCropRect,
	SourceOverlapEdge,
	SourceRasterPoint,
	SourceTransform
} from '../domain/provenance';
import { integerTranslationOf } from './renderComposite';
import { detectSemanticLandmarkBatch } from './semanticLandmarks';
import type {
	SemanticLandmarkBatchResult,
	SemanticRaster
} from './semanticLandmarks';
import { loadCv, warmMatchTemplate } from './cvMatch';
import type {
	RunStitchPipeline,
	StitchConfidence,
	StitchPipelineFailure,
	StitchPipelinePerformance,
	StitchPipelineResult
} from './pipelineResult';

export { renderPipelineComposite } from './renderComposite';
export type { PipelineRenderEnv, RgbaBuffer } from './renderComposite';

export interface StitchPipelineOptions {
	readonly applyCropMargin?: boolean;
	readonly decode?: DecodeImageFile;
	readonly buildRaster?: (image: HTMLImageElement, region?: RasterRegion) => AnalysisRaster;
	readonly buildCropRaster?: (image: HTMLImageElement) => AnalysisRaster;
	readonly buildSemanticRaster?: (image: HTMLImageElement, sourceId: string) => SemanticRaster;
	readonly hash?: HashBytes;
	readonly createSourceId?: () => string;
	readonly now?: () => number;
}

interface DecodedSource {
	readonly file: File;
	readonly image: HTMLImageElement;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly sha256: string;
}

function browserNow(): number {
	return typeof performance !== 'undefined' && typeof performance.now === 'function'
		? performance.now()
		: Date.now();
}

export function semanticRasterFromImage(image: HTMLImageElement, sourceId: string): SemanticRaster {
	const widthPx = image.naturalWidth;
	const heightPx = image.naturalHeight;
	const canvas = document.createElement('canvas');
	canvas.width = widthPx;
	canvas.height = heightPx;
	const context = canvas.getContext('2d', { willReadFrequently: true });
	if (!context) throw new Error('semanticRasterFromImage: canvas 2D context unavailable');
	context.drawImage(image, 0, 0, widthPx, heightPx);
	return {
		sourceId,
		widthPx,
		heightPx,
		rgba: context.getImageData(0, 0, widthPx, heightPx).data
	};
}

function incoherentFailure(message: string): StitchPipelineResult {
	return { ok: false, failure: { reason: 'incoherent', message } };
}

function cropRectFrom(insets: CropInsets | null, widthPx: number, heightPx: number): SourceCropRect {
	const { topPx, rightPx, bottomPx, leftPx } = insets ?? ZERO_CROP;
	return {
		xPx: leftPx,
		yPx: topPx,
		widthPx: widthPx - leftPx - rightPx,
		heightPx: heightPx - topPx - bottomPx
	};
}

function cropCorners(crop: SourceCropRect): readonly SourceRasterPoint[] {
	return [
		{ xPx: crop.xPx, yPx: crop.yPx },
		{ xPx: crop.xPx + crop.widthPx, yPx: crop.yPx },
		{ xPx: crop.xPx + crop.widthPx, yPx: crop.yPx + crop.heightPx },
		{ xPx: crop.xPx, yPx: crop.yPx + crop.heightPx }
	];
}

async function decodeAndHashFiles(
	files: readonly File[],
	decode: DecodeImageFile,
	hash: HashBytes
): Promise<DecodedSource[] | StitchPipelineResult> {
	const decoded: DecodedSource[] = [];
	let requirement: { widthPx: number; heightPx: number } | null = null;
	for (const file of files) {
		if (!isSupportedMimeType(file.type)) {
			return incoherentFailure(
				`Unsupported file type "${file.type || 'unknown'}" for "${file.name}": ChainSpot accepts PNG and JPEG images.`
			);
		}
		let result: DecodedImage;
		try {
			result = await decode(file);
		} catch {
			return incoherentFailure(`Could not decode "${file.name}".`);
		}
		const { widthPx, heightPx } = result;
		if (!Number.isFinite(widthPx) || !Number.isFinite(heightPx) || widthPx <= 0 || heightPx <= 0) {
			return incoherentFailure(
				`"${file.name}" decoded with invalid dimensions (${widthPx} x ${heightPx}); width and height must be greater than zero.`
			);
		}
		if (!requirement) {
			requirement = { widthPx, heightPx };
		} else if (widthPx !== requirement.widthPx || heightPx !== requirement.heightPx) {
			return incoherentFailure(
				`"${file.name}" is ${widthPx} x ${heightPx} but the batch requires ${requirement.widthPx} x ${requirement.heightPx}. Recapture all screenshots at the same device orientation and screenshot size.`
			);
		}
		let bytes: Uint8Array;
		try {
			bytes = await readFileBytes(file);
		} catch {
			return incoherentFailure(`Could not read "${file.name}" to compute its hash.`);
		}
		const sha256 = await hash(bytes);
		decoded.push({ file, image: result.image, widthPx, heightPx, sha256 });
	}
	return decoded;
}

function trySemanticLandmarks(
	decoded: readonly DecodedSource[],
	sourceIds: readonly string[],
	buildSemanticRaster: (image: HTMLImageElement, sourceId: string) => SemanticRaster
): SemanticLandmarkBatchResult | undefined {
	try {
		return detectSemanticLandmarkBatch(
			decoded.map((source, index) => buildSemanticRaster(source.image, sourceIds[index]))
		);
	} catch (error) {
		console.warn('[ChainSpot stitch] semantic landmark scan failed; preserving OpenCV fallback.', error);
		return undefined;
	}
}

function emptyPerformance(decodeAndHashMs: number): StitchPipelinePerformance {
	return {
		decodeAndHashMs,
		cropMs: 0,
		semanticLandmarkMs: 0,
		opencvWarmMs: 0,
		poseMs: 0,
		semanticPairSolveMs: 0,
		localVerificationMs: 0,
		globalFallbackMs: 0,
		pathCounts: { semanticLocalVerify: 0, semanticDisagreement: 0, globalFallback: 0 }
	};
}

function buildSingleSourcePipeline(
	decoded: DecodedSource,
	buildCropRaster: (image: HTMLImageElement) => AnalysisRaster,
	buildSemanticRaster: (image: HTMLImageElement, sourceId: string) => SemanticRaster,
	applyCropMargin: boolean,
	createSourceId: () => string,
	now: () => number,
	decodeAndHashMs: number
): StitchPipelineResult {
	const performanceReport = emptyPerformance(decodeAndHashMs);
	let cropInsets: CropInsets | null = null;
	let cropConfidence: 'high' | 'low' | 'absent' = 'absent';
	const cropStartedAt = now();
	try {
		const raster = buildCropRaster(decoded.image);
		const proposal = proposeSingleImageCrop(raster, {
			marginPx: applyCropMargin ? DEFAULT_CROP_SAFETY_MARGIN_PX : 0
		});
		cropInsets = proposal.insets;
		cropConfidence = proposal.confidence;
	} catch {
		cropInsets = null;
		cropConfidence = 'absent';
	}
	const cropMs = now() - cropStartedAt;
	const sourceId = createSourceId();
	const semanticStartedAt = now();
	const semanticLandmarks = trySemanticLandmarks([decoded], [sourceId], buildSemanticRaster);
	const semanticLandmarkMs = now() - semanticStartedAt;

	const crop = cropRectFrom(cropInsets, decoded.widthPx, decoded.heightPx);
	const transform = translationSourceTransform(-crop.xPx, -crop.yPx);
	const coveragePolygon = cropCorners(crop).map((corner) => applySourceTransform(corner, transform));
	const source: SourceCapture = {
		sourceId,
		fileName: decoded.file.name,
		mimeType: decoded.file.type,
		widthPx: decoded.widthPx,
		heightPx: decoded.heightPx,
		sha256: decoded.sha256,
		crop,
		transform,
		origin: AUTO_SOURCE_CAPTURE_ORIGIN,
		coveragePolygon,
		paintOrder: 0
	};
	const draft: DraftComposite = {
		schemaVersion: CURRENT_PROVENANCE_SCHEMA_VERSION,
		renderVersion: CURRENT_RENDER_VERSION,
		outputWidthPx: crop.widthPx,
		outputHeightPx: crop.heightPx,
		compositingPolicy: 'single-source-v1',
		resampling: 'none',
		sources: [source],
		overlaps: []
	};
	const confidence: StitchConfidence = cropConfidence === 'low' ? 'review' : 'auto';
	const warnings = cropConfidence === 'low'
		? ['Crop boundary is uncertain for this capture; review the crop before continuing.']
		: [];

	return {
		ok: true,
		result: {
			confidence,
			warnings,
			draft,
			sources: [{ ...source, file: decoded.file }],
			...(semanticLandmarks ? { semanticLandmarks } : {}),
			performance: { ...performanceReport, cropMs, semanticLandmarkMs }
		}
	};
}

async function buildMultiSourcePipeline(
	decoded: readonly DecodedSource[],
	buildRaster: (image: HTMLImageElement, region?: RasterRegion) => AnalysisRaster,
	buildCropRaster: (image: HTMLImageElement) => AnalysisRaster,
	buildSemanticRaster: (image: HTMLImageElement, sourceId: string) => SemanticRaster,
	applyCropMargin: boolean,
	createSourceId: () => string,
	now: () => number,
	decodeAndHashMs: number
): Promise<StitchPipelineResult> {
	const cropStartedAt = now();
	let crop: CropProposalDetail | null;
	try {
		crop = proposeCropDetailed(
			decoded.map((d) => buildCropRaster(d.image)),
			{ marginPx: applyCropMargin ? DEFAULT_CROP_SAFETY_MARGIN_PX : 0 }
		);
	} catch {
		crop = null;
	}
	const cropMs = now() - cropStartedAt;
	const sourceIds = decoded.map(() => createSourceId());

	// Start CV load/warm before the synchronous semantic scan. Browser fetch /
	// WASM compilation can overlap the pure-TS work; the graph awaits this only
	// before it needs local/global CV verification.
	const opencvWarmStartedAt = now();
	const opencvWarmPromise = loadCv().then((cv) => {
		warmMatchTemplate(cv);
		return now() - opencvWarmStartedAt;
	});

	const semanticStartedAt = now();
	const semanticLandmarks = trySemanticLandmarks(decoded, sourceIds, buildSemanticRaster);
	const semanticLandmarkMs = now() - semanticStartedAt;

	const rasters: AnalysisRaster[] = [];
	const matcherRegionOffsets: Array<{ readonly xPx: number; readonly yPx: number } | null> = [];
	for (let i = 0; i < decoded.length; i += 1) {
		const region = matcherRegionFromCrop(crop, decoded[i].widthPx, decoded[i].heightPx);
		matcherRegionOffsets.push(region ? { xPx: region.x, yPx: region.y } : null);
		try {
			rasters.push(buildRaster(decoded[i].image, region ?? undefined));
		} catch {
			return incoherentFailure(`Could not analyze "${decoded[i].file.name}".`);
		}
	}

	const duplicate = findDuplicateRasters(rasters);
	if (duplicate) {
		return {
			ok: false,
			failure: {
				reason: 'duplicate',
				message: duplicateImageMessage(
					decoded[duplicate.firstIndex].file.name,
					decoded[duplicate.duplicateIndex].file.name
				),
				duplicate
			}
		};
	}

	let opencvWarmMs: number;
	try {
		opencvWarmMs = await opencvWarmPromise;
	} catch (error) {
		return incoherentFailure(
			`OpenCV stitch verification could not initialize: ${error instanceof Error ? error.message : String(error)}`
		);
	}

	const poseStartedAt = now();
	const pose = await buildPoseGraph(rasters, { semanticSources: semanticLandmarks?.sources });
	const poseMs = now() - poseStartedAt;
	if (!pose.ok) return { ok: false, failure: { reason: 'incoherent', message: pose.message } };

	const cropRect = cropRectFrom(crop?.insets ?? null, decoded[0].widthPx, decoded[0].heightPx);
	const corners = cropCorners(cropRect);
	const correctedTransforms = new Map<number, SourceTransform>();
	for (const index of pose.order) {
		const raw = pose.transforms.get(index)!;
		const offset = matcherRegionOffsets[index];
		if (!offset || (offset.xPx === 0 && offset.yPx === 0)) {
			correctedTransforms.set(index, raw);
			continue;
		}
		const [a, b, c, d, e, f] = raw.coefficients;
		const correctedE = e + offset.xPx - (a * offset.xPx + c * offset.yPx);
		const correctedF = f + offset.yPx - (b * offset.xPx + d * offset.yPx);
		correctedTransforms.set(index, buildSourceTransform(raw.model, [a, b, c, d, correctedE, correctedF]));
	}

	const rawPolygons = new Map<number, readonly CompositePoint[]>();
	for (const index of pose.order) {
		const transform = correctedTransforms.get(index)!;
		rawPolygons.set(index, corners.map((corner) => applySourceTransform(corner, transform)));
	}
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const polygon of rawPolygons.values()) {
		for (const point of polygon) {
			minX = Math.min(minX, point.xPx);
			maxX = Math.max(maxX, point.xPx);
			minY = Math.min(minY, point.yPx);
			maxY = Math.max(maxY, point.yPx);
		}
	}
	const shiftX = -Math.floor(minX);
	const shiftY = -Math.floor(minY);
	const outputWidthPx = Math.ceil(maxX) - Math.floor(minX);
	const outputHeightPx = Math.ceil(maxY) - Math.floor(minY);
	const shiftCoefficients: Affine6Coefficients = [1, 0, 0, 1, shiftX, shiftY];

	const finalTransforms = new Map<number, SourceTransform>();
	const finalPolygons = new Map<number, readonly CompositePoint[]>();
	for (const index of pose.order) {
		const corrected = correctedTransforms.get(index)!;
		const transform = buildSourceTransform(
			corrected.model,
			composeAffine6(shiftCoefficients, corrected.coefficients)
		);
		finalTransforms.set(index, transform);
		finalPolygons.set(index, corners.map((corner) => applySourceTransform(corner, transform)));
	}

	const paintKey = pose.order.map((index) => ({
		index,
		key: Math.max(...finalPolygons.get(index)!.map((p) => p.xPx + p.yPx))
	}));
	paintKey.sort((a, b) => a.key - b.key || a.index - b.index);
	const paintOrderOf = new Map<number, number>();
	paintKey.forEach((entry, rank) => paintOrderOf.set(entry.index, rank));

	const sources: SourceCapture[] = decoded.map((d, index) => ({
		sourceId: sourceIds[index],
		fileName: d.file.name,
		mimeType: d.file.type,
		widthPx: d.widthPx,
		heightPx: d.heightPx,
		sha256: d.sha256,
		crop: cropRect,
		transform: finalTransforms.get(index)!,
		origin: AUTO_SOURCE_CAPTURE_ORIGIN,
		coveragePolygon: finalPolygons.get(index)!,
		paintOrder: paintOrderOf.get(index)!
	}));

	const overlaps: SourceOverlapEdge[] = pose.edges.map((edge) => ({
		a: sourceIds[edge.parent],
		b: sourceIds[edge.child],
		kind: edge.kind,
		score: edge.score
	}));
	const resampling: ResamplingMethod = sources.every((source) => integerTranslationOf(source.transform) !== null)
		? 'none'
		: 'nearest';
	const draft: DraftComposite = {
		schemaVersion: CURRENT_PROVENANCE_SCHEMA_VERSION,
		renderVersion: CURRENT_RENDER_VERSION,
		outputWidthPx,
		outputHeightPx,
		compositingPolicy: 'stitch-ascending-bottom-right-v1',
		resampling,
		sources,
		overlaps
	};

	const weakPlacementEdges = pose.placementEdges.filter((edge) => edge.score < WEAK_EDGE_MAX_SCORE);
	const semanticDisagreements = pose.pairDiagnostics.filter((probe) => probe.path === 'semantic-disagreement');
	const cropWeak = crop?.confidence === 'low';
	const warnings: string[] = [];
	if (weakPlacementEdges.length > 0) {
		warnings.push(
			`Weak neighbor match between ${weakPlacementEdges
				.map((edge) => `"${decoded[edge.parent].file.name}"-"${decoded[edge.child].file.name}"`)
				.join(', ')}: these screenshots may not share enough overlapping map content, or one may be from a different capture.`
		);
	}
	if (semanticDisagreements.length > 0) {
		warnings.push(
			`Semantic landmarks and local pixel verification disagreed on ${semanticDisagreements.length} source pair${semanticDisagreements.length === 1 ? '' : 's'}; global OpenCV fallback supplied those edges for review.`
		);
	}
	if (cropWeak) warnings.push('Crop boundary is uncertain; review the crop before continuing.');
	const confidence: StitchConfidence =
		weakPlacementEdges.length > 0 || semanticDisagreements.length > 0 || cropWeak ? 'review' : 'auto';

	const pathCounts = {
		semanticLocalVerify: pose.pairDiagnostics.filter((probe) => probe.path === 'semantic-local-verify').length,
		semanticDisagreement: semanticDisagreements.length,
		globalFallback: pose.pairDiagnostics.filter((probe) => probe.path === 'global-fallback').length
	};
	const performanceReport: StitchPipelinePerformance = {
		decodeAndHashMs,
		cropMs,
		semanticLandmarkMs,
		opencvWarmMs,
		poseMs,
		semanticPairSolveMs: pose.pairDiagnostics.reduce((sum, probe) => sum + probe.semanticVoteMs, 0),
		localVerificationMs: pose.pairDiagnostics.reduce((sum, probe) => sum + probe.localVerifyMs, 0),
		globalFallbackMs: pose.pairDiagnostics.reduce((sum, probe) => sum + probe.globalFallbackMs, 0),
		pathCounts
	};

	return {
		ok: true,
		result: {
			confidence,
			warnings,
			draft,
			sources: sources.map((source, index) => ({ ...source, file: decoded[index].file })),
			...(semanticLandmarks ? { semanticLandmarks } : {}),
			pairDiagnostics: pose.pairDiagnostics,
			performance: performanceReport
		}
	};
}

export async function runStitchPipeline(
	files: readonly File[],
	options: StitchPipelineOptions = {}
): Promise<StitchPipelineResult> {
	const {
		applyCropMargin = true,
		decode = decodeImageFile,
		buildCropRaster = toCropRaster,
		buildSemanticRaster = semanticRasterFromImage,
		hash = sha256Hex,
		createSourceId = () => globalThis.crypto.randomUUID(),
		now = browserNow
	} = options;
	const buildRaster: (image: HTMLImageElement, region?: RasterRegion) => AnalysisRaster =
		options.buildRaster ?? ((image, region) => toAnalysisRaster(image, undefined, region));

	if (files.length === 0 || files.length > MAX_POSE_GRAPH_TILES) {
		return {
			ok: false,
			failure: {
				reason: 'wrong-count',
				message: `Expected 1 to ${MAX_POSE_GRAPH_TILES} screenshots, got ${files.length}.`
			}
		};
	}

	const decodeStartedAt = now();
	const decodedOrFailure = await decodeAndHashFiles(files, decode, hash);
	const decodeAndHashMs = now() - decodeStartedAt;
	if (!Array.isArray(decodedOrFailure)) return decodedOrFailure;
	const decoded = decodedOrFailure;

	if (decoded.length === 1) {
		return buildSingleSourcePipeline(
			decoded[0],
			buildCropRaster,
			buildSemanticRaster,
			applyCropMargin,
			createSourceId,
			now,
			decodeAndHashMs
		);
	}
	return buildMultiSourcePipeline(
		decoded,
		buildRaster,
		buildCropRaster,
		buildSemanticRaster,
		applyCropMargin,
		createSourceId,
		now,
		decodeAndHashMs
	);
}

const _pipelineContractCheck: RunStitchPipeline = runStitchPipeline;
void _pipelineContractCheck;

export type { StitchPipelineFailure };
