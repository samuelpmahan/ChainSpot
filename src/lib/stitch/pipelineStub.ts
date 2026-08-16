/**
 * TODO(orchestrator): replace with Agent B's real `runStitchPipeline` /
 * `renderPipelineComposite` implementation (CHSPT-50, generalized
 * rotation-aware stitch) once it lands, and delete this file.
 *
 * `src/lib/stitch/pipelineResult.ts` locks the *type* contract Agent C1's
 * Stitch Map UI builds against, but only declares `RunStitchPipeline` /
 * `RenderPipelineComposite` as function *types* — no implementing function
 * ships there (that is Agent B's file to add). This module is a minimal,
 * clearly-temporary bridge over today's existing `autoCrop.ts` /
 * `smartImport.ts` / canvas-compositing primitives, so the UI has something
 * real to call and this slice's own logic/tests are not blocked on Agent B's
 * landing. It deliberately does NOT implement CHSPT-50's generalized
 * rotation-aware stitch: every transform this module produces is
 * `translation`-only (matching the "ordinary 2x2 remains an important
 * regression fixture" requirement), duplicate/incoherence detection is
 * whatever `smartImportFiles` already does, and rendering only ever
 * `drawImage`s at an integer translation (the one case
 * `domain/provenance.ts`'s module doc documents as byte-exact-safe without a
 * hand-written resampler).
 */
import {
	decodeImageFile,
	isSupportedMimeType,
	readFileBytes,
	sha256Hex
} from '../imageIntake';
import {
	applySourceTransform,
	identitySourceTransform,
	sealCompositeProvenance,
	translationSourceTransform,
	AUTO_SOURCE_CAPTURE_ORIGIN,
	CURRENT_PROVENANCE_SCHEMA_VERSION,
	CURRENT_RENDER_VERSION
} from '../domain/provenance';
import type {
	CompositingPolicy,
	CompositeProvenance,
	DraftComposite,
	SourceCapture,
	SourceCropRect,
	SourceOverlapEdge,
	SourceRasterPoint
} from '../domain/provenance';
import { DEFAULT_CROP_SAFETY_MARGIN_PX, proposeSingleImageCrop } from './autoCrop';
import { toCropRaster } from './analysis';
import { MAX_AUTO_ARRANGE_TILES } from './autoLayout';
import { smartImportViaWorker } from './smartImport';
import { ZERO_CROP, tileRect, translatedOrigin, unionBounds } from './geometry';
import type { CropInsets, TilePlacement, TileSlot } from './geometry';
import type {
	DraftSourceCapture,
	RenderPipelineComposite,
	RunStitchPipeline,
	StitchConfidence,
	StitchPipelineFailure,
	StitchPipelineResult,
	StitchPipelineSuccess
} from './pipelineResult';

function fail(failure: StitchPipelineFailure): StitchPipelineResult {
	return { ok: false, failure };
}

function succeed(result: StitchPipelineSuccess): StitchPipelineResult {
	return { ok: true, result };
}

function cropCornersOf(crop: SourceCropRect): readonly SourceRasterPoint[] {
	return [
		{ xPx: crop.xPx, yPx: crop.yPx },
		{ xPx: crop.xPx + crop.widthPx, yPx: crop.yPx },
		{ xPx: crop.xPx + crop.widthPx, yPx: crop.yPx + crop.heightPx },
		{ xPx: crop.xPx, yPx: crop.yPx + crop.heightPx }
	];
}

let sourceIdSequence = 0;
function nextSourceId(): string {
	sourceIdSequence += 1;
	return `stub-source-${Date.now().toString(36)}-${sourceIdSequence}`;
}

/**
 * N=1: AutoCrop only. A lone capture is always `'auto'` unless its own crop
 * confidence is `'low'` — an `'absent'` crop proposal (nothing to trim) is
 * not itself a problem.
 */
async function runSingle(file: File, applyCropMargin: boolean): Promise<StitchPipelineResult> {
	if (!isSupportedMimeType(file.type)) {
		return fail({
			reason: 'incoherent',
			message: `Unsupported file type "${file.type || 'unknown'}": ChainSpot accepts PNG and JPEG images.`
		});
	}
	let decoded: { image: HTMLImageElement; widthPx: number; heightPx: number };
	try {
		decoded = await decodeImageFile(file);
	} catch {
		return fail({ reason: 'incoherent', message: `Could not decode "${file.name}".` });
	}
	const { image, widthPx, heightPx } = decoded;
	if (!Number.isFinite(widthPx) || !Number.isFinite(heightPx) || widthPx <= 0 || heightPx <= 0) {
		return fail({
			reason: 'incoherent',
			message: `"${file.name}" decoded with invalid dimensions (${widthPx} x ${heightPx}).`
		});
	}

	const raster = toCropRaster(image);
	const proposal = proposeSingleImageCrop(raster, {
		marginPx: applyCropMargin ? DEFAULT_CROP_SAFETY_MARGIN_PX : 0
	});
	const crop: CropInsets = proposal.insets ?? ZERO_CROP;
	const croppedWidthPx = widthPx - crop.leftPx - crop.rightPx;
	const croppedHeightPx = heightPx - crop.topPx - crop.bottomPx;
	if (croppedWidthPx <= 0 || croppedHeightPx <= 0) {
		return fail({
			reason: 'incoherent',
			message: `The proposed crop for "${file.name}" leaves no visible image content.`
		});
	}

	const confidence: StitchConfidence = proposal.confidence === 'low' ? 'review' : 'auto';
	const warnings: string[] =
		confidence === 'review'
			? [
					'Automatic crop confidence is low for this screenshot; verify the crop before trusting the result.'
				]
			: [];

	const bytes = await readFileBytes(file);
	const hash = await sha256Hex(bytes);
	const cropRect: SourceCropRect = {
		xPx: crop.leftPx,
		yPx: crop.topPx,
		widthPx: croppedWidthPx,
		heightPx: croppedHeightPx
	};
	const transform = identitySourceTransform();
	const sourceId = nextSourceId();
	const capture: SourceCapture = {
		sourceId,
		fileName: file.name,
		mimeType: file.type,
		widthPx,
		heightPx,
		sha256: hash,
		crop: cropRect,
		transform,
		coveragePolygon: cropCornersOf(cropRect).map((corner) => applySourceTransform(corner, transform)),
		paintOrder: 0,
		origin: AUTO_SOURCE_CAPTURE_ORIGIN
	};

	const draft: DraftComposite = {
		schemaVersion: CURRENT_PROVENANCE_SCHEMA_VERSION,
		renderVersion: CURRENT_RENDER_VERSION,
		outputWidthPx: croppedWidthPx,
		outputHeightPx: croppedHeightPx,
		compositingPolicy: 'single-source-v1',
		resampling: 'none',
		sources: [capture],
		overlaps: []
	};

	return succeed({
		confidence,
		warnings,
		draft,
		sources: [{ ...capture, file }]
	});
}

/**
 * N>1: AutoCrop + AutoStitch, bridging today's worker-backed
 * `smartImportViaWorker` into the locked draft/provenance shape. Routed
 * through the worker (not the in-process `smartImportFiles`) so the page's
 * existing eager `warmSmartStitchWorker()` call on mount actually pays off
 * for this stub too, matching CHSPT-55's "worker-side CV stays warm" intent.
 * The one cost: the worker reply omits `AutoLayout`'s raw `placementEdges`,
 * so this stub's `overlaps` is always empty — a real Agent B implementation
 * can thread that through its own worker contract.
 */
async function runMulti(files: readonly File[], applyCropMargin: boolean): Promise<StitchPipelineResult> {
	const result = await smartImportViaWorker(files, { applyCropMargin });
	if (!result.ok) {
		if ('stale' in result) {
			// smartImportViaWorker's own staleness guard defaults to "always
			// current" when the caller supplies no `isCurrent`, so this branch is
			// unreachable here — present only to satisfy the union exhaustively.
			return fail({ reason: 'incoherent', message: 'Import was interrupted before it could complete.' });
		}
		if (result.kind === 'wrong-count') {
			return fail({
				reason: 'wrong-count',
				message: `Import screenshots supports one to ${MAX_AUTO_ARRANGE_TILES} files; received ${result.count}.`
			});
		}
		if (result.reason === 'duplicate-image') {
			return fail({ reason: 'duplicate', message: result.message });
		}
		return fail({ reason: 'incoherent', message: result.message });
	}

	const crop: CropInsets = result.cropProposal ?? ZERO_CROP;
	const cropConfidenceLow = result.crop.confidence === 'low';
	const layoutOk = result.diagnostic.category === 'ok';
	const confidence: StitchConfidence = layoutOk && !cropConfidenceLow ? 'auto' : 'review';
	const warnings: string[] = [...result.diagnostic.warnings];
	if (cropConfidenceLow) {
		warnings.push('Crop suggestion confidence is low; verify the crop before trusting the stitched result.');
	}

	// Every tile shares the shared crop's dimensions once trimmed — resolve
	// them from the first placed tile's own decoded size.
	const anchorTile = result.tiles[result.assignment[result.order[0]] ?? 0];
	const croppedWidthPx = anchorTile.widthPx - crop.leftPx - crop.rightPx;
	const croppedHeightPx = anchorTile.heightPx - crop.topPx - crop.bottomPx;
	if (croppedWidthPx <= 0 || croppedHeightPx <= 0) {
		return fail({ reason: 'incoherent', message: 'The proposed shared crop leaves no visible image content.' });
	}

	const placedSlots = result.order.filter(
		(slot) => result.assignment[slot] !== undefined && result.placements[slot]
	);
	const unionRects = placedSlots.map((slot) => tileRect(result.placements[slot]!, croppedWidthPx, croppedHeightPx));
	const union = unionBounds(unionRects);
	if (!union) {
		return fail({ reason: 'incoherent', message: 'No screenshots could be placed.' });
	}
	const { dxPx, dyPx } = translatedOrigin(union);

	// Ascending bottom-right paint order — same rule `render.ts` uses today.
	const paintOrder = [...placedSlots].sort((a, b) => {
		const pa = result.placements[a]!;
		const pb = result.placements[b]!;
		return pa.xPx + pa.yPx - (pb.xPx + pb.yPx);
	});
	const paintOrderIndex = new Map<TileSlot, number>(paintOrder.map((slot, index) => [slot, index]));

	const cropRect: SourceCropRect = { xPx: crop.leftPx, yPx: crop.topPx, widthPx: croppedWidthPx, heightPx: croppedHeightPx };
	const cropCorners = cropCornersOf(cropRect);

	const sourceIdBySlot = new Map<TileSlot, string>();
	const fileBySlot = new Map<TileSlot, File>();
	const captures: SourceCapture[] = [];
	for (const slot of placedSlots) {
		const fileIndex = result.assignment[slot]!;
		const tile = result.tiles[fileIndex];
		const placement = result.placements[slot]! as TilePlacement;
		const sourceId = nextSourceId();
		sourceIdBySlot.set(slot, sourceId);
		fileBySlot.set(slot, files[fileIndex]);
		const bytes = await readFileBytes(files[fileIndex]);
		const hash = await sha256Hex(bytes);
		const transform = translationSourceTransform(placement.xPx + dxPx, placement.yPx + dyPx);
		captures.push({
			sourceId,
			fileName: tile.fileName,
			mimeType: tile.mimeType,
			widthPx: tile.widthPx,
			heightPx: tile.heightPx,
			sha256: hash,
			crop: cropRect,
			transform,
			coveragePolygon: cropCorners.map((corner) => applySourceTransform(corner, transform)),
			paintOrder: paintOrderIndex.get(slot)!,
			origin: AUTO_SOURCE_CAPTURE_ORIGIN
		});
	}

	// The worker reply carries no raw `AutoLayout`/`placementEdges` (see the
	// module doc on `runMulti`), so this stub never populates `overlaps`; an
	// empty list is valid per `assertCoherentProvenance`.
	const overlaps: SourceOverlapEdge[] = [];

	const compositingPolicy: CompositingPolicy =
		captures.length === 1 ? 'single-source-v1' : 'stitch-ascending-bottom-right-v1';

	const draft: DraftComposite = {
		schemaVersion: CURRENT_PROVENANCE_SCHEMA_VERSION,
		renderVersion: CURRENT_RENDER_VERSION,
		outputWidthPx: union.widthPx,
		outputHeightPx: union.heightPx,
		compositingPolicy,
		resampling: 'none',
		sources: captures,
		overlaps
	};

	const sources: DraftSourceCapture[] = captures.map((capture) => ({
		...capture,
		file: fileBySlot.get(
			[...sourceIdBySlot.entries()].find(([, id]) => id === capture.sourceId)![0]
		)!
	}));

	return succeed({ confidence, warnings, draft, sources });
}

export const runStitchPipeline: RunStitchPipeline = async (files, options) => {
	const applyCropMargin = options?.applyCropMargin ?? true;
	if (files.length === 0) {
		return fail({ reason: 'wrong-count', message: 'Select at least one screenshot to import.' });
	}
	if (files.length === 1) {
		return runSingle(files[0], applyCropMargin);
	}
	return runMulti(files, applyCropMargin);
};

/**
 * Paints `draft` onto an offscreen canvas at native resolution and hashes
 * the result. Every transform this stub ever produces is `translation`-only
 * (see the module doc), so a plain integer-offset `drawImage` per source is
 * exact — the one case `domain/provenance.ts` documents as safe without a
 * hand-written resampler. A `'similarity'`/`'affine'` draft (hand-authored,
 * never produced by this stub) is rejected rather than silently
 * mis-rendered.
 */
export const renderPipelineComposite: RenderPipelineComposite = async (draft, sources) => {
	if (draft.outputWidthPx <= 0 || draft.outputHeightPx <= 0) {
		throw new Error(
			`renderPipelineComposite: invalid output dimensions ${draft.outputWidthPx} x ${draft.outputHeightPx}`
		);
	}
	const canvas = document.createElement('canvas');
	canvas.width = draft.outputWidthPx;
	canvas.height = draft.outputHeightPx;
	const context = canvas.getContext('2d');
	if (!context) {
		throw new Error('renderPipelineComposite: canvas 2D context unavailable');
	}
	const byPaintOrder = [...draft.sources].sort((a, b) => a.paintOrder - b.paintOrder);
	for (const source of byPaintOrder) {
		const image = sources.get(source.sourceId);
		if (!image) {
			throw new Error(`renderPipelineComposite: no decoded image supplied for source '${source.sourceId}'`);
		}
		if (source.transform.model !== 'translation') {
			throw new Error(
				`renderPipelineComposite (stub): source '${source.sourceId}' uses a '${source.transform.model}' transform; this temporary stub only renders translation-only drafts (see the module doc).`
			);
		}
		const [, , , , e, f] = source.transform.coefficients;
		context.drawImage(
			image,
			source.crop.xPx,
			source.crop.yPx,
			source.crop.widthPx,
			source.crop.heightPx,
			Math.round(e),
			Math.round(f),
			source.crop.widthPx,
			source.crop.heightPx
		);
	}
	const blob = await new Promise<Blob>((resolve, reject) => {
		canvas.toBlob((result) => {
			if (result) resolve(result);
			else reject(new Error('renderPipelineComposite: PNG encoding failed.'));
		}, 'image/png');
	});
	const bytes = new Uint8Array(await blob.arrayBuffer());
	const hash = await sha256Hex(bytes);
	const provenance: CompositeProvenance = sealCompositeProvenance(draft, hash);
	return { blob, provenance };
};
