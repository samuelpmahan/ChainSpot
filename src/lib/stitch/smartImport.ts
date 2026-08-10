/**
 * ChainSpot Stitch Map smart four-tile import orchestration (P1-001).
 *
 * One local-only bulk action: accepts exactly four PNG/JPEG screenshots in any
 * order, validates every file (supported MIME, successful decode, finite
 * positive intrinsic dimensions, identical dimensions), runs the pairwise
 * overlap analysis, assigns the fixed 2×2 layout, proposes a shared crop, and
 * returns one coherent commit payload for the caller (the route) to publish.
 *
 * Atomicity: nothing is committed here and no state is mutated. On any file
 * failure the whole batch rejects with the offending file identified, leaving
 * the caller's current valid stitch session untouched. Staleness: the caller
 * supplies `isCurrent` (typically the established per-batch generation guard);
 * if a newer selection/reset invalidated the batch mid-flight, a stale success
 * or failure reports `stale` and never overwrites the newer result.
 *
 * Analysis never touches the network: decode, rasters, and matching are all
 * local browser resources that become unreachable once the batch settles.
 */
import { isSupportedMimeType, decodeImageFile } from '../imageIntake';
import type { DecodedImage, DecodeImageFile } from '../imageIntake';
import { toAnalysisRaster, toCropRaster } from './analysis';
import type { AnalysisRaster, RasterRegion } from './analysis';
import { assignFour } from './autoLayout';
import type { AutoLayout } from './autoLayout';
import { proposeCropDetailed } from './autoCrop';
import type { CropProposalDetail } from './autoCrop';
import { duplicateImageMessage, findDuplicateRasters } from './duplicates';
import type { DuplicateRasterPair } from './duplicates';
import { classifyLayout } from './diagnostics';
import type { LayoutDiagnostic } from './diagnostics';
import { matcherRegionFromCrop } from './cropGate';
import type { CropInsets } from './geometry';
import type { TilePlacement, TileSlot } from './geometry';

export interface SmartImportTile {
	readonly fileName: string;
	readonly mimeType: string;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly image: HTMLImageElement;
}

export interface SmartImportCrop {
	/** The proposed shared crop, or null when edge evidence is inconsistent. */
	readonly proposal: CropInsets | null;
	/** Crop confidence, separate from layout confidence (P1-002). */
	readonly confidence: 'high' | 'low' | 'absent';
}

export interface SmartImportSuccess {
	readonly ok: true;
	/** One entry per file, in selection order; `assignment` maps slots to indices. */
	readonly tiles: readonly SmartImportTile[];
	readonly assignment: Record<TileSlot, number>;
	readonly placements: Record<TileSlot, TilePlacement>;
	readonly layout: AutoLayout;
	/** The proposed shared crop, or null when edge evidence is inconsistent. */
	readonly cropProposal: CropInsets | null;
	/** Crop proposal plus its confidence, surfaced separately from layout. */
	readonly crop: SmartImportCrop;
	/** Text confidence category plus concrete warnings (P1-002). */
	readonly diagnostic: LayoutDiagnostic;
}

export type SmartImportFileFailureKind =
	| 'unsupported-type'
	| 'decode-failure'
	| 'invalid-dimension'
	| 'dimension-mismatch'
	| 'duplicate-image';

export type SmartImportFailure =
	| { readonly ok: false; stale: true }
	| { readonly ok: false; kind: 'wrong-count'; count: number }
	| {
			readonly ok: false;
			kind: 'file';
			fileName: string;
			reason: SmartImportFileFailureKind;
			message: string;
	  };

export type SmartImportResult = SmartImportSuccess | SmartImportFailure;

/**
 * The worker-backed analysis result: identical to `SmartImportSuccess` except
 * the raw layout evidence (including gray rasters) never crosses the worker
 * boundary. The route consumes only the fields both shapes share.
 */
export type SmartImportWorkerSuccess = Omit<SmartImportSuccess, 'layout'>;
export type SmartImportWorkerResult = SmartImportWorkerSuccess | SmartImportFailure;

export interface SmartImportOptions {
	/** Injectable browser decoder; defaults to the object-URL `Image.decode()` path. */
	decode?: DecodeImageFile;
	/**
	 * Injectable downscaled-grayscale matcher-raster builder; defaults to the
	 * canvas path. The optional `region` argument, when supplied, is the
	 * interior sub-rectangle a confidently defensible shared crop identified
	 * (see `matcherRegionFromCrop`); implementations should draw from it
	 * instead of the whole frame.
	 */
	buildRaster?: (image: HTMLImageElement, region?: RasterRegion) => AnalysisRaster;
	/**
	 * Injectable crop-analysis raster builder; defaults to a dedicated
	 * 1024-long-edge representation separate from the low-resolution matcher
	 * raster, so crop boundaries are not quantized to the matcher's 10-12
	 * original pixels per analysis line.
	 */
	buildCropRaster?: (image: HTMLImageElement) => AnalysisRaster;
	/** Returns false once a newer selection/reset invalidated this batch. */
	isCurrent?: () => boolean;
}

/**
 * Validates, decodes, analyzes, and assembles exactly four screenshots. The
 * caller decides when to publish the returned payload, so a failure never
 * damages the current session and a stale result never publishes.
 */
export async function smartImportFiles(
	files: readonly File[],
	options: SmartImportOptions = {}
): Promise<SmartImportResult> {
	const {
		decode = decodeImageFile,
		buildCropRaster = toCropRaster,
		isCurrent = () => true
	} = options;
	// `toAnalysisRaster` takes a `maxDim` in the middle, so it is wrapped to
	// match this narrower two-argument shape instead of being used directly.
	const buildRaster: (image: HTMLImageElement, region?: RasterRegion) => AnalysisRaster =
		options.buildRaster ?? ((image, region) => toAnalysisRaster(image, undefined, region));

	if (files.length !== 4) {
		return { ok: false, kind: 'wrong-count', count: files.length };
	}
	if (!isCurrent()) return { ok: false, stale: true };

	const decoded: DecodedImage[] = [];
	let requirement: { widthPx: number; heightPx: number } | null = null;
	for (let i = 0; i < files.length; i += 1) {
		const file = files[i];
		if (!isSupportedMimeType(file.type)) {
			return {
				ok: false,
				kind: 'file',
				fileName: file.name,
				reason: 'unsupported-type',
				message: `Unsupported file type "${file.type || 'unknown'}": ChainSpot accepts PNG and JPEG images.`
			};
		}
		let result: DecodedImage;
		try {
			result = await decode(file);
		} catch {
			if (!isCurrent()) return { ok: false, stale: true };
			return {
				ok: false,
				kind: 'file',
				fileName: file.name,
				reason: 'decode-failure',
				message: `Could not decode "${file.name}".`
			};
		}
		if (!isCurrent()) return { ok: false, stale: true };
		const { widthPx, heightPx } = result;
		if (!Number.isFinite(widthPx) || !Number.isFinite(heightPx) || widthPx <= 0 || heightPx <= 0) {
			return {
				ok: false,
				kind: 'file',
				fileName: file.name,
				reason: 'invalid-dimension',
				message: `"${file.name}" decoded with invalid dimensions (${widthPx} x ${heightPx}); width and height must be greater than zero.`
			};
		}
		if (!requirement) {
			requirement = { widthPx, heightPx };
		} else if (widthPx !== requirement.widthPx || heightPx !== requirement.heightPx) {
			return {
				ok: false,
				kind: 'file',
				fileName: file.name,
				reason: 'dimension-mismatch',
				message: `"${file.name}" is ${widthPx} x ${heightPx} but the batch requires ${requirement.widthPx} x ${requirement.heightPx}. Recapture all four screenshots at the same device orientation and screenshot size.`
			};
		}
		decoded.push(result);
	}

	// Crop evidence is computed first, from the full frame, because a
	// confidently defensible shared crop is used to trim the matcher rasters
	// below to their interior content before pairwise scoring — see
	// `matcherRegionFromCrop`. The dedicated higher-resolution crop rasters feed
	// crop analysis only; the matcher rasters stay at their bounded low
	// resolution. A crop-analysis failure never fails the import: it yields an
	// honest absent proposal and matcher rasters fall back to the whole frame.
	let crop: CropProposalDetail | null = null;
	try {
		crop = proposeCropDetailed(decoded.map((result) => buildCropRaster(result.image)));
	} catch {
		crop = null;
	}
	if (!isCurrent()) return { ok: false, stale: true };

	const rasters: AnalysisRaster[] = [];
	for (let i = 0; i < decoded.length; i += 1) {
		const region = matcherRegionFromCrop(crop, decoded[i].widthPx, decoded[i].heightPx);
		try {
			rasters.push(buildRaster(decoded[i].image, region ?? undefined));
		} catch {
			if (!isCurrent()) return { ok: false, stale: true };
			return {
				ok: false,
				kind: 'file',
				fileName: files[i].name,
				reason: 'decode-failure',
				message: `Could not analyze "${files[i].name}".`
			};
		}
	}
	if (!isCurrent()) return { ok: false, stale: true };

	// Rejected before scoring, not warned about after: with the same screenshot
	// twice there is no 2×2 to find, so any arrangement the matcher returned
	// would stack two tiles and silently export a map missing a quarter of the
	// course. Heavy overlap between genuinely different captures is fine and is
	// never rejected here — only pixel-identical images are (see duplicates.ts).
	const duplicate = findDuplicateRasters(rasters);
	if (duplicate) {
		return {
			ok: false,
			kind: 'file',
			fileName: files[duplicate.duplicateIndex].name,
			reason: 'duplicate-image',
			message: duplicateImageMessage(
				files[duplicate.firstIndex].name,
				files[duplicate.duplicateIndex].name
			)
		};
	}

	const layout = await assignFour(rasters);
	const diagnostic = classifyLayout(layout);
	if (!isCurrent()) return { ok: false, stale: true };

	// Crop confidence is independent of layout confidence (see cropGate.ts):
	// whatever crop evidence exists is surfaced as-is.
	const cropResult: SmartImportCrop = {
		proposal: crop?.insets ?? null,
		confidence: crop?.confidence ?? 'absent'
	};

	const tiles: SmartImportTile[] = decoded.map((result, i) => ({
		fileName: files[i].name,
		mimeType: files[i].type,
		widthPx: result.widthPx,
		heightPx: result.heightPx,
		image: result.image
	}));

	return {
		ok: true,
		tiles,
		assignment: layout.assignment,
		placements: layout.placements,
		layout,
		cropProposal: cropResult.proposal,
		crop: cropResult,
		diagnostic
	};
}

/**
 * One focused smart-stitch worker shared by every import. It exists because the
 * Chromium measurement observed multi-hundred-millisecond main-thread blocks;
 * the worker owns rasterization (OffscreenCanvas) and all pure analysis.
 * Terminate it with `disposeSmartStitchWorker` when the page no longer owns it.
 */
let smartStitchWorker: Worker | null = null;

export function disposeSmartStitchWorker(): void {
	if (smartStitchWorker) {
		smartStitchWorker.terminate();
		smartStitchWorker = null;
	}
}

/**
 * Eagerly constructs the singleton smart-stitch worker (P1-002 1b), so its
 * module-scope `loadCv()` call (see `smartStitch.worker.ts`) kicks off the
 * worker-side OpenCV WASM load on Stitch Map route mount instead of waiting
 * for the first real smart-import call. A no-op once the worker already
 * exists — the same singleton `analyzeInWorker` reuses. Deliberately not
 * awaited by callers: this only warms the worker, it never runs analysis.
 */
export function warmSmartStitchWorker(): void {
	if (smartStitchWorker) return;
	smartStitchWorker = new Worker(new URL('./smartStitch.worker.ts', import.meta.url), {
		type: 'module'
	});
}

/**
 * The P1-002 production intake path: identical validation, atomicity, stale
 * protection, crop gating, and result semantics to `smartImportFiles`, but the
 * decode-for-analysis uses off-main-thread ImageBitmap creation and the raster
 * building plus all analysis run inside the single smart-stitch worker, so the
 * main thread is never blocked for the measured multi-hundred-millisecond
 * analysis spans. The decoded rendering images are still produced on the main
 * thread through the normal decode path.
 */
export async function smartImportViaWorker(
	files: readonly File[],
	options: { isCurrent?: () => boolean } = {}
): Promise<SmartImportWorkerResult> {
	const { isCurrent = () => true } = options;

	if (files.length !== 4) {
		return { ok: false, kind: 'wrong-count', count: files.length };
	}
	if (!isCurrent()) return { ok: false, stale: true };

	const decoded: DecodedImage[] = [];
	const bitmaps: ImageBitmap[] = [];
	let requirement: { widthPx: number; heightPx: number } | null = null;
	for (let i = 0; i < files.length; i += 1) {
		const file = files[i];
		if (!isSupportedMimeType(file.type)) {
			return {
				ok: false,
				kind: 'file',
				fileName: file.name,
				reason: 'unsupported-type',
				message: `Unsupported file type "${file.type || 'unknown'}": ChainSpot accepts PNG and JPEG images.`
			};
		}
		let result: DecodedImage;
		try {
			result = await decodeImageFile(file);
		} catch {
			if (!isCurrent()) return { ok: false, stale: true };
			return {
				ok: false,
				kind: 'file',
				fileName: file.name,
				reason: 'decode-failure',
				message: `Could not decode "${file.name}".`
			};
		}
		if (!isCurrent()) return { ok: false, stale: true };
		let bitmap: ImageBitmap;
		try {
			bitmap = await createImageBitmap(file);
		} catch {
			if (!isCurrent()) return { ok: false, stale: true };
			return {
				ok: false,
				kind: 'file',
				fileName: file.name,
				reason: 'decode-failure',
				message: `Could not analyze "${file.name}".`
			};
		}
		if (!isCurrent()) return { ok: false, stale: true };
		const widthPx = bitmap.width;
		const heightPx = bitmap.height;
		if (!Number.isFinite(widthPx) || !Number.isFinite(heightPx) || widthPx <= 0 || heightPx <= 0) {
			bitmap.close();
			return {
				ok: false,
				kind: 'file',
				fileName: file.name,
				reason: 'invalid-dimension',
				message: `"${file.name}" decoded with invalid dimensions (${widthPx} x ${heightPx}); width and height must be greater than zero.`
			};
		}
		if (!requirement) {
			requirement = { widthPx, heightPx };
		} else if (widthPx !== requirement.widthPx || heightPx !== requirement.heightPx) {
			bitmap.close();
			return {
				ok: false,
				kind: 'file',
				fileName: file.name,
				reason: 'dimension-mismatch',
				message: `"${file.name}" is ${widthPx} x ${heightPx} but the batch requires ${requirement.widthPx} x ${requirement.heightPx}. Recapture all four screenshots at the same device orientation and screenshot size.`
			};
		}
		decoded.push(result);
		bitmaps.push(bitmap);
	}
	if (!isCurrent()) return { ok: false, stale: true };

	const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
	let reply: WorkerReply;
	try {
		reply = await analyzeInWorker(token, bitmaps);
	} catch (error) {
		// A rejection here means the worker transport itself failed (construction,
		// message-channel error) rather than an internal analysis error — internal
		// errors are caught inside the worker and arrive as a typed `ok: false`
		// reply instead. Treat it the same as any other file-analysis failure so
		// this path is never the one silent exception in an otherwise fully typed
		// function, and discard the worker in case it is left in a broken state.
		disposeSmartStitchWorker();
		if (!isCurrent()) return { ok: false, stale: true };
		return {
			ok: false,
			kind: 'file',
			fileName: files[0].name,
			reason: 'decode-failure',
			message: `Smart-import analysis failed: ${error instanceof Error ? error.message : String(error)}.`
		};
	}
	if (!isCurrent() || reply.token !== token) return { ok: false, stale: true };
	if (!reply.ok) {
		// The worker holds the rasters, so it is the side that can see two
		// supplied images are the same picture; only this side knows their file
		// names. Mapping happens here so the message the user reads is identical
		// to the one the in-process path produces.
		if (reply.duplicate) {
			const { firstIndex, duplicateIndex } = reply.duplicate;
			return {
				ok: false,
				kind: 'file',
				fileName: files[duplicateIndex].name,
				reason: 'duplicate-image',
				message: duplicateImageMessage(files[firstIndex].name, files[duplicateIndex].name)
			};
		}
		return {
			ok: false,
			kind: 'file',
			fileName: files[0].name,
			reason: 'decode-failure',
			message: `Smart-import analysis failed: ${reply.message ?? 'unknown error'}.`
		};
	}

	const tiles: SmartImportTile[] = decoded.map((result, i) => ({
		fileName: files[i].name,
		mimeType: files[i].type,
		widthPx: result.widthPx,
		heightPx: result.heightPx,
		image: result.image
	}));

	return {
		ok: true,
		tiles,
		assignment: reply.assignment,
		placements: reply.placements,
		cropProposal: reply.cropProposal,
		crop: reply.crop,
		diagnostic: reply.diagnostic
	};
}

type WorkerReply =
	| {
			readonly ok: true;
			readonly token: string;
			readonly assignment: SmartImportWorkerSuccess['assignment'];
			readonly placements: SmartImportWorkerSuccess['placements'];
			readonly cropProposal: SmartImportWorkerSuccess['cropProposal'];
			readonly crop: SmartImportWorkerSuccess['crop'];
			readonly diagnostic: SmartImportWorkerSuccess['diagnostic'];
	  }
	| {
			readonly ok: false;
			readonly token: string;
			readonly message?: string;
			readonly duplicate?: DuplicateRasterPair;
	  };

function analyzeInWorker(token: string, bitmaps: readonly ImageBitmap[]): Promise<WorkerReply> {
	warmSmartStitchWorker();
	const worker = smartStitchWorker as Worker;
	return new Promise((resolve, reject) => {
		const onMessage = (event: MessageEvent<WorkerReply>): void => {
			if (event.data.token !== token) return;
			worker.removeEventListener('message', onMessage);
			worker.removeEventListener('error', onError);
			resolve(event.data);
		};
		const onError = (): void => {
			worker.removeEventListener('message', onMessage);
			reject(new Error('smart-stitch worker failed'));
		};
		worker.addEventListener('message', onMessage);
		worker.addEventListener('error', onError, { once: true });
		worker.postMessage({ token, bitmaps }, bitmaps as unknown as Transferable[]);
	});
}
