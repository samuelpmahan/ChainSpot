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
import { toAnalysisRaster } from './analysis';
import type { AnalysisRaster } from './analysis';
import { assignFour } from './autoLayout';
import type { AutoLayout } from './autoLayout';
import { proposeCropDetailed } from './autoCrop';
import { classifyLayout } from './diagnostics';
import type { LayoutDiagnostic } from './diagnostics';
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
	| 'dimension-mismatch';

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

export interface SmartImportOptions {
	/** Injectable browser decoder; defaults to the object-URL `Image.decode()` path. */
	decode?: DecodeImageFile;
	/** Injectable downscaled-grayscale builder; defaults to the canvas path. */
	buildRaster?: (image: HTMLImageElement) => AnalysisRaster;
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
	const { decode = decodeImageFile, buildRaster = toAnalysisRaster, isCurrent = () => true } = options;

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

	const rasters: AnalysisRaster[] = [];
	for (let i = 0; i < decoded.length; i += 1) {
		try {
			rasters.push(buildRaster(decoded[i].image));
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

	const layout = assignFour(rasters);
	const crop = proposeCropDetailed(rasters);
	const diagnostic = classifyLayout(layout, rasters);
	if (!isCurrent()) return { ok: false, stale: true };

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
		cropProposal: crop.insets,
		crop: { proposal: crop.insets, confidence: crop.confidence },
		diagnostic
	};
}
