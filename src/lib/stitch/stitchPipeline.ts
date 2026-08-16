/**
 * ChainSpot Stitch Map source-intake pipeline entry point (CHSPT-50/55/56):
 * `pipelineResult.ts`'s `runStitchPipeline` — the ONE call both N=1 (AutoCrop
 * only) and N>1 (AutoCrop + AutoStitch) go through. Decodes and hashes every
 * file (reusing `imageIntake.ts`'s `decodeImageFile`/`readFileBytes`/
 * `sha256Hex`), proposes the shared crop (reusing `autoCrop.ts` exactly as
 * `smartImportFiles` does), places/estimates poses (`poseGraph.ts`'s
 * `buildPoseGraph` for N>1; N=1 needs no placement at all), duplicate-checks
 * (`duplicates.ts`), and assembles a `DraftComposite` — never rendering a
 * raster itself (see `renderComposite.ts`'s `renderPipelineComposite` for
 * that).
 *
 * `smartImport.ts` re-exports `runStitchPipeline`/`renderPipelineComposite`
 * from here rather than this module living inside `smartImport.ts` directly,
 * so the legacy N-tile `TilePlacement`-based intake path (`smartImportFiles`/
 * `smartImportViaWorker`, still what today's Stitch Map UI and
 * `smartStitch.worker.ts` depend on) and this new `DraftComposite`-based path
 * stay textually separate even though they share several lower-level
 * modules (`autoCrop.ts`, `duplicates.ts`, `cropGate.ts`).
 *
 * TWO GAPS FOUND IN THE LOCKED `pipelineResult.ts` CONTRACT (flagged per the
 * plan's instruction to implement around a genuine gap rather than edit the
 * contract):
 *
 * 1. `StitchPipelineFailureReason` has exactly three members ('wrong-count',
 *    'duplicate', 'incoherent') — there is no reason for an ordinary
 *    file-level intake problem (unsupported MIME type, a file that fails to
 *    decode, invalid/mismatched dimensions), which `smartImportFiles`'s
 *    richer `SmartImportFileFailureKind` union used to distinguish. This
 *    module reports all such problems as `reason: 'incoherent'` — "no
 *    defensible composite can be built from this batch" is the closest true
 *    statement the locked union supports — with the specific problem
 *    preserved in `message` (e.g. exactly which file and why).
 * 2. There is no `stale` failure variant (unlike the legacy
 *    `SmartImportFailure`'s `{ ok: false, stale: true }`, and unlike
 *    `RunStitchPipeline`'s own `options` having no `isCurrent`-style hook
 *    either). This module does not attempt in-flight staleness protection at
 *    all — that responsibility has moved entirely to the caller (e.g.
 *    discard a resolved promise superseded by a newer call), which the
 *    locked contract's shape is consistent with.
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
import type {
	RunStitchPipeline,
	StitchConfidence,
	StitchPipelineFailure,
	StitchPipelineResult
} from './pipelineResult';

export { renderPipelineComposite } from './renderComposite';
export type { PipelineRenderEnv, RgbaBuffer } from './renderComposite';

/** Injectable seams beyond the locked `RunStitchPipeline` options shape, for deterministic unit tests; production callers never pass these. */
export interface StitchPipelineOptions {
	readonly applyCropMargin?: boolean;
	readonly decode?: DecodeImageFile;
	readonly buildRaster?: (image: HTMLImageElement, region?: RasterRegion) => AnalysisRaster;
	readonly buildCropRaster?: (image: HTMLImageElement) => AnalysisRaster;
	readonly hash?: HashBytes;
	readonly createSourceId?: () => string;
}

interface DecodedSource {
	readonly file: File;
	readonly image: HTMLImageElement;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly sha256: string;
}

function incoherentFailure(message: string): StitchPipelineResult {
	return { ok: false, failure: { reason: 'incoherent', message } };
}

function cropRectFrom(insets: CropInsets | null, widthPx: number, heightPx: number): SourceCropRect {
	const { topPx, rightPx, bottomPx, leftPx } = insets ?? ZERO_CROP;
	return { xPx: leftPx, yPx: topPx, widthPx: widthPx - leftPx - rightPx, heightPx: heightPx - topPx - bottomPx };
}

/** Corner order [top-left, top-right, bottom-right, bottom-left] — matches `domain/provenance.ts`'s own (private) `cropCorners` exactly, since `SourceCapture.coveragePolygon` must be in that order for `assertCoherentProvenance`. */
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

function buildSingleSourcePipeline(
	decoded: DecodedSource,
	buildCropRaster: (image: HTMLImageElement) => AnalysisRaster,
	applyCropMargin: boolean,
	createSourceId: () => string
): StitchPipelineResult {
	let cropInsets: CropInsets | null = null;
	let cropConfidence: 'high' | 'low' | 'absent' = 'absent';
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

	const crop = cropRectFrom(cropInsets, decoded.widthPx, decoded.heightPx);
	const transform = translationSourceTransform(-crop.xPx, -crop.yPx);
	const coveragePolygon = cropCorners(crop).map((corner) => applySourceTransform(corner, transform));

	const source: SourceCapture = {
		sourceId: createSourceId(),
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

	// N=1 is always `'auto'` unless its own crop confidence is low (see
	// `pipelineResult.ts`'s `StitchConfidence` doc comment, which specifies
	// this exact rule).
	const confidence: StitchConfidence = cropConfidence === 'low' ? 'review' : 'auto';
	const warnings: string[] =
		cropConfidence === 'low'
			? ['Crop boundary is uncertain for this capture; review the crop before continuing.']
			: [];

	return {
		ok: true,
		result: {
			confidence,
			warnings,
			draft,
			sources: [{ ...source, file: decoded.file }]
		}
	};
}

async function buildMultiSourcePipeline(
	decoded: readonly DecodedSource[],
	buildRaster: (image: HTMLImageElement, region?: RasterRegion) => AnalysisRaster,
	buildCropRaster: (image: HTMLImageElement) => AnalysisRaster,
	applyCropMargin: boolean,
	createSourceId: () => string
): Promise<StitchPipelineResult> {
	let crop: CropProposalDetail | null;
	try {
		crop = proposeCropDetailed(
			decoded.map((d) => buildCropRaster(d.image)),
			{ marginPx: applyCropMargin ? DEFAULT_CROP_SAFETY_MARGIN_PX : 0 }
		);
	} catch {
		crop = null;
	}

	const rasters: AnalysisRaster[] = [];
	for (let i = 0; i < decoded.length; i += 1) {
		const region = matcherRegionFromCrop(crop, decoded[i].widthPx, decoded[i].heightPx);
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

	const pose = await buildPoseGraph(rasters);
	if (!pose.ok) {
		return { ok: false, failure: { reason: 'incoherent', message: pose.message } };
	}

	const cropRect = cropRectFrom(crop?.insets ?? null, decoded[0].widthPx, decoded[0].heightPx);
	const corners = cropCorners(cropRect);

	// Raw (anchor-relative) coverage polygons, to find the union bounds that
	// become the output's (0,0) origin — generalizes `geometry.ts`'s
	// `unionBounds`/`translatedOrigin` from axis-aligned tile rects to
	// arbitrary (possibly rotated) coverage polygons.
	const rawPolygons = new Map<number, readonly CompositePoint[]>();
	for (const index of pose.order) {
		const transform = pose.transforms.get(index)!;
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
		const raw = pose.transforms.get(index)!;
		const transform = buildSourceTransform(raw.model, composeAffine6(shiftCoefficients, raw.coefficients));
		finalTransforms.set(index, transform);
		finalPolygons.set(index, corners.map((corner) => applySourceTransform(corner, transform)));
	}

	// Paint order (`compositingPolicy: 'stitch-ascending-bottom-right-v1'`):
	// ascending by each source's OWN coveragePolygon's bottom-right-most
	// corner (max corner x+y), ties keep the caller's original file order.
	// Generalizes `render.ts`'s "ascending bottom-right, ties keep caller
	// order" rule from same-size axis-aligned tile rects (where ranking by
	// top-left x+y and by bottom-right x+y are equivalent, since every tile
	// shares the same width+height offset between the two) to placements
	// that may now be rotated and are no longer necessarily the same size in
	// composite space.
	const paintKey = pose.order.map((index) => ({
		index,
		key: Math.max(...finalPolygons.get(index)!.map((p) => p.xPx + p.yPx))
	}));
	paintKey.sort((a, b) => a.key - b.key || a.index - b.index);
	const paintOrderOf = new Map<number, number>();
	paintKey.forEach((entry, rank) => paintOrderOf.set(entry.index, rank));

	const sourceIds = decoded.map(() => createSourceId());
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
	const cropWeak = crop?.confidence === 'low';
	const warnings: string[] = [];
	if (weakPlacementEdges.length > 0) {
		warnings.push(
			`Weak neighbor match between ${weakPlacementEdges
				.map((edge) => `"${decoded[edge.parent].file.name}"-"${decoded[edge.child].file.name}"`)
				.join(', ')}: these screenshots may not share enough overlapping map content, or one may be from a different capture.`
		);
	}
	if (cropWeak) {
		warnings.push('Crop boundary is uncertain; review the crop before continuing.');
	}
	const confidence: StitchConfidence = weakPlacementEdges.length > 0 || cropWeak ? 'review' : 'auto';

	return {
		ok: true,
		result: {
			confidence,
			warnings,
			draft,
			sources: sources.map((source, index) => ({ ...source, file: decoded[index].file }))
		}
	};
}

/**
 * `pipelineResult.ts`'s `runStitchPipeline`: covers N=1 (AutoCrop only) and
 * N>1 (AutoCrop + AutoStitch) through this one call. See the module doc
 * comment for the two locked-contract gaps this implementation works around.
 */
export async function runStitchPipeline(
	files: readonly File[],
	options: StitchPipelineOptions = {}
): Promise<StitchPipelineResult> {
	const {
		applyCropMargin = true,
		decode = decodeImageFile,
		buildCropRaster = toCropRaster,
		hash = sha256Hex,
		createSourceId = () => globalThis.crypto.randomUUID()
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

	const decodedOrFailure = await decodeAndHashFiles(files, decode, hash);
	if (!Array.isArray(decodedOrFailure)) return decodedOrFailure;
	const decoded = decodedOrFailure;

	if (decoded.length === 1) {
		return buildSingleSourcePipeline(decoded[0], buildCropRaster, applyCropMargin, createSourceId);
	}
	return buildMultiSourcePipeline(decoded, buildRaster, buildCropRaster, applyCropMargin, createSourceId);
}

// Compile-time-only check that `runStitchPipeline` stays assignable to
// `pipelineResult.ts`'s locked `RunStitchPipeline` contract (its `options`
// parameter is a strict superset of `{ applyCropMargin? }`, so this is a
// widening, not a narrowing, of that type). Never referenced at runtime.
const _pipelineContractCheck: RunStitchPipeline = runStitchPipeline;
void _pipelineContractCheck;

export type { StitchPipelineFailure };
