/**
 * ChainSpot Stitch Map smart-import analysis worker (P1-002).
 *
 * One focused worker for the smart-import analysis only, introduced because the
 * Chromium measurement (`scripts/perf-smart-import.mjs`) observed multi-hundred-
 * millisecond main-thread blocks during decode + rasterization + assignment on
 * representative large captures. The worker receives transferred ImageBitmaps,
 * builds the low-resolution matcher rasters and the dedicated higher-resolution
 * crop rasters with OffscreenCanvas, runs the pure analysis (assignment, crop
 * proposal, layout classification), and posts back a serializable result.
 *
 * Contract:
 * - In: `{ token, bitmaps }` where bitmaps are ImageBitmap transfers.
 * - Out: `{ ok: true, token, assignment, placements, cropProposal, crop,
 *   diagnostic }` — everything JSON-safe; gray rasters never cross the boundary.
 * - Out: `{ ok: false, token, message }` on analysis failure.
 * - The token is echoed unchanged so the caller can discard stale replies.
 * - Bitmaps are closed in the worker after use.
 *
 * All analysis modules here are pure (no DOM, no canvas of their own), so the
 * results are deterministic given the same decoded pixels — identical to the
 * inline analysis path unit tests exercise.
 */
import { assignFour, assignTwo, layoutForSlots } from './autoLayout';
import type { AutoLayout } from './autoLayout';
import { proposeCropDetailed } from './autoCrop';
import { classifyLayout } from './diagnostics';
import { findDuplicateRasters } from './duplicates';
import type { DuplicateRasterPair } from './duplicates';
import { DEFAULT_CROP_ANALYSIS_MAX_DIM, DEFAULT_MAX_ANALYSIS_DIM } from './analysis';
import type { AnalysisRaster, RasterRegion } from './analysis';
import { matcherRegionFromCrop } from './cropGate';
import { loadCv, warmMatchTemplate } from './cvMatch';
import type { StitchLayout, TileSlot } from './geometry';

// Eager warm-up (P1-002 1b, extended 1c): a worker is constructed once and
// reused for the life of the tab (see `smartImport.ts`'s `smartStitchWorker`
// singleton), so kicking off the OpenCV WASM load as soon as this module
// first evaluates — i.e. as soon as the worker is constructed, well before
// any real analysis request arrives — moves the ~6-8.5s cold parse+compile
// off the critical path of the first actual smart-import call. Fire-and-
// forget: `loadCv()` caches its promise, so the real `assignFour` call below
// simply awaits the same (by then likely already-resolved) instance.
//
// Once `loadCv()` resolves, `warmMatchTemplate` runs one throwaway
// `matchTemplate` call so that any one-time compile/lazy-init cost the first
// real call in this thread might carry, on top of the module load above, is
// paid during this same idle warm-up window instead of on the first real
// four-tile analysis (see `cvMatch.ts`'s `warmMatchTemplate` doc comment for
// what this session's own re-measurement did and did not confirm).
void loadCv().then((cv) => warmMatchTemplate(cv));

interface WorkerRequest {
	readonly token: string;
	readonly bitmaps: readonly ImageBitmap[];
}

interface WorkerReply {
	readonly ok: boolean;
	readonly token: string;
	readonly message?: string;
	/**
	 * Set instead of `message` when analysis stopped because two supplied images
	 * are pixel-identical. Indices are into the request's `bitmaps`, which the
	 * caller maps back to file names for the user-facing sentence.
	 */
	readonly duplicate?: DuplicateRasterPair;
	readonly assignment?: AutoLayout['assignment'];
	readonly placements?: AutoLayout['placements'];
	readonly layoutKind?: StitchLayout;
	readonly cropProposal?: ReturnType<typeof proposeCropDetailed>['insets'];
	readonly crop?: { readonly proposal: ReturnType<typeof proposeCropDetailed>['insets']; readonly confidence: 'high' | 'low' | 'absent' };
	readonly diagnostic?: ReturnType<typeof classifyLayout>;
}

function rasterFromBitmap(bitmap: ImageBitmap, maxDim: number, region?: RasterRegion): AnalysisRaster {
	const sourceX = region?.x ?? 0;
	const sourceY = region?.y ?? 0;
	const sourceWidth = region?.width ?? bitmap.width;
	const sourceHeight = region?.height ?? bitmap.height;
	const scaleFactor = Math.min(1, maxDim / Math.max(sourceWidth, sourceHeight));
	const widthPx = Math.max(1, Math.round(sourceWidth * scaleFactor));
	const heightPx = Math.max(1, Math.round(sourceHeight * scaleFactor));
	const canvas = new OffscreenCanvas(widthPx, heightPx);
	const context = canvas.getContext('2d');
	if (!context) {
		throw new Error('smartStitch.worker: OffscreenCanvas 2D context unavailable');
	}
	context.drawImage(bitmap, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, widthPx, heightPx);
	const data = context.getImageData(0, 0, widthPx, heightPx).data;
	const gray = new Uint8Array(widthPx * heightPx);
	for (let i = 0, j = 0; i < data.length; i += 4, j += 1) {
		gray[j] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114 + 0.5) | 0;
	}
	return {
		widthPx,
		heightPx,
		gray,
		scale: sourceWidth / widthPx
	};
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
	const { token, bitmaps } = event.data;
	try {
		// Crop evidence is computed first, from the full frame, so a confidently
		// defensible shared crop can trim the matcher rasters to their interior
		// content before pairwise scoring — see `matcherRegionFromCrop`.
		const cropRasters = bitmaps.map((bitmap) =>
			rasterFromBitmap(bitmap, DEFAULT_CROP_ANALYSIS_MAX_DIM)
		);
		const crop = proposeCropDetailed(cropRasters);
		const matcher = bitmaps.map((bitmap) => {
			const region = matcherRegionFromCrop(crop, bitmap.width, bitmap.height);
			return rasterFromBitmap(bitmap, DEFAULT_MAX_ANALYSIS_DIM, region ?? undefined);
		});
		// Rejected before scoring: with the same screenshot twice there is no
		// arrangement to find, so any arrangement the matcher returned would
		// stack two tiles and export a map silently missing part of the course.
		// Reported by raster index because only the caller knows the file names.
		const duplicate = findDuplicateRasters(matcher);
		if (duplicate) {
			const reply: WorkerReply = { ok: false, token, duplicate };
			(self as unknown as Worker).postMessage(reply);
			return;
		}

		const layout = matcher.length === 4 ? await assignFour(matcher) : await assignTwo(matcher);
		const layoutKind = layoutForSlots(Object.keys(layout.assignment) as TileSlot[]);
		const diagnostic = classifyLayout(layout, layoutKind);
		// Crop confidence is independent of layout confidence (see cropGate.ts):
		// whatever crop evidence exists is surfaced as-is.
		const cropResult = { proposal: crop.insets, confidence: crop.confidence };
		const reply: WorkerReply = {
			ok: true,
			token,
			assignment: layout.assignment,
			placements: layout.placements,
			layoutKind,
			cropProposal: cropResult.proposal,
			crop: cropResult,
			diagnostic
		};
		(self as unknown as Worker).postMessage(reply);
	} catch (error) {
		const reply: WorkerReply = {
			ok: false,
			token,
			message: error instanceof Error ? error.message : String(error)
		};
		(self as unknown as Worker).postMessage(reply);
	} finally {
		for (const bitmap of bitmaps) bitmap.close();
	}
};
