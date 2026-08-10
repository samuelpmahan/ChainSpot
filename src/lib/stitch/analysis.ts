/**
 * ChainSpot Stitch Map raster construction and shared pairwise-analysis types
 * (P1-001, matcher replaced with OpenCV in the fifth P1-002 round; Snap moved
 * onto the same matcher in P1-002 1b).
 *
 * The actual translation matching (what used to live here as a hand-rolled
 * mean-absolute-difference block search) is now `cvMatch.ts`'s
 * `matchTemplate`-backed matcher; see that module's doc comment for why. The
 * manual-correction "Snap" assist (`snapAlign`/`scoreOffsetAt`) used to be the
 * one holdout still running its own mean-absolute-difference local search
 * here — that has also moved to `cvMatch.ts` (`snapAlign`/
 * `matchTranslationNear`), since the old search had a real quantization/
 * directional tie-break bug. This module now provides only:
 *
 * - `AnalysisRaster` construction (`toAnalysisRaster`/`toCropRaster`), shared
 *   by the matcher, the crop analyzer, and Snap;
 * - `PairEstimate`/`PairEstimates`, the shared shape both the matcher's
 *   results and the crop/diagnostics consumers describe pairwise evidence
 *   with.
 */
export interface AnalysisRaster {
	readonly widthPx: number;
	readonly heightPx: number;
	readonly gray: Uint8Array;
	/**
	 * Original-image pixels per analysis pixel. A single factor because the
	 * downscale preserves aspect ratio; committed values multiply by this.
	 */
	readonly scale: number;
}

export type PairOrientation = 'left-right' | 'top-bottom';

export interface PairEstimate {
	readonly orientation: PairOrientation;
	/** Original-image pixel translation of the second tile relative to the first. */
	readonly dxPx: number;
	readonly dyPx: number;
	/**
	 * Match strength, higher is better: `cvMatch`'s `matchTemplate` results are
	 * a normalized cross-correlation peak in [-1, 1] (see `cvMatch.ts`; real
	 * map content peaks at 0.99+).
	 */
	readonly score: number;
	/** Shared overlap width/height as a fraction of the tile dimension. */
	readonly overlapFractionPx: number;
	/**
	 * Best score among candidates clearly displaced from the winner. A
	 * runner-up close to the winner means repeated imagery offers an ambiguous
	 * alternative; feeds P1-002 confidence.
	 */
	readonly runnerUpScore: number;
}

/**
 * Both orientation-specific hypotheses for one ordered pair, retained so the
 * caller can score and place each expected edge with its required orientation
 * instead of whichever hypothesis happened to win.
 */
export interface PairEstimates {
	readonly 'left-right': PairEstimate;
	readonly 'top-bottom': PairEstimate;
	/** The winning orientation between the two hypotheses; ties prefer `left-right`. */
	readonly orientation: PairOrientation;
}

/**
 * Long-edge limit of the stitch-matching raster fed to `cvMatch`. Under the old
 * mean-absolute-difference matcher this was kept small (240px) because that
 * matcher's cost scaled with raster area and it ran a wide brute-force search;
 * accuracy on the real capture was independently confirmed working at
 * *full-resolution, uncapped* rasters (`tests/unit/_scratch_cvmatch.test.ts`),
 * because `cvMatch.ts`'s own coarse-to-fine search (see its
 * `COARSE_DOWNSAMPLE_FACTOR`) is what keeps matching cost bounded now, not a
 * low-resolution raster upstream of it. A raster capped at 240px throws away
 * the sub-pixel precision `cvMatch`'s fine pass is capable of: the fine pass
 * can only ever be as precise as the raster it is given, and 240px on a
 * ~2000px-tall real capture tile quantizes to roughly 9 original pixels per
 * analysis row.
 *
 * 4096 is chosen as a generous cap on realistic screenshot sizes (comfortably
 * above current phone/tablet long edges, e.g. 2796px) rather than as a cost
 * control: it exists only to bound pathological/oversized uploads, not to
 * bound ordinary matching cost, which `cvMatch.ts` already bounds internally.
 */
export const DEFAULT_MAX_ANALYSIS_DIM = 4096;
/**
 * Long-edge limit of the dedicated crop-analysis raster.
 *
 * Validation change: ordinary phone screenshots now stay at native resolution.
 * The entropy crop benchmark showed the old 1024px cap introduced a systematic
 * ~3-4 source-pixel undercrop on 1290x2796 UDisc screenshots, while native
 * analysis reduced that to exactly one pixel on all 18 labeled top/bottom
 * boundaries. 4096 still bounds pathological uploads while leaving current
 * phone captures untouched.
 */
export const DEFAULT_CROP_ANALYSIS_MAX_DIM = 4096;

/**
 * An optional source sub-rectangle in original-image pixels, so a raster can be
 * built from a trimmed interior region instead of always the whole frame at
 * (0, 0). Used to build matcher rasters from the interior of a confidently
 * cropped capture (see `cropGate.ts`'s `matcherRegionFromCrop`) while crop
 * detection itself keeps scanning the full frame.
 */
export interface RasterRegion {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/**
 * Builds a downscaled grayscale raster from a decoded image, optionally from a
 * source sub-`region` rather than the whole frame. Canvas access is
 * browser-only; deterministic unit tests feed synthetic rasters directly.
 */
export function toAnalysisRaster(
	image: HTMLImageElement,
	maxDim: number = DEFAULT_MAX_ANALYSIS_DIM,
	region?: RasterRegion
): AnalysisRaster {
	const sourceX = region?.x ?? 0;
	const sourceY = region?.y ?? 0;
	const sourceWidth = region?.width ?? image.naturalWidth;
	const sourceHeight = region?.height ?? image.naturalHeight;
	const scaleFactor = Math.min(1, maxDim / Math.max(sourceWidth, sourceHeight));
	const scaledWidth = Math.max(1, Math.round(sourceWidth * scaleFactor));
	const scaledHeight = Math.max(1, Math.round(sourceHeight * scaleFactor));
	const canvas = document.createElement('canvas');
	canvas.width = scaledWidth;
	canvas.height = scaledHeight;
	const context = canvas.getContext('2d');
	if (!context) {
		throw new Error('toAnalysisRaster: canvas 2D context unavailable');
	}
	context.drawImage(
		image,
		sourceX,
		sourceY,
		sourceWidth,
		sourceHeight,
		0,
		0,
		scaledWidth,
		scaledHeight
	);
	const data = context.getImageData(0, 0, scaledWidth, scaledHeight).data;
	const gray = new Uint8Array(scaledWidth * scaledHeight);
	for (let i = 0, j = 0; i < data.length; i += 4, j += 1) {
		gray[j] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114 + 0.5) | 0;
	}
	return {
		widthPx: scaledWidth,
		heightPx: scaledHeight,
		gray,
		scale: sourceWidth / scaledWidth
	};
}

/**
 * The dedicated crop-analysis raster: the same grayscale pipeline at a much
 * higher long-edge limit than the stitch matcher's, so crop boundaries resolve
 * to a few original pixels instead of the matcher's ~10-12. Same shape as
 * `AnalysisRaster`; `scale` maps boundary lines back to integer original-image
 * pixels. Identical source dimensions (the intake contract) yield identical
 * scale factors, so cross-tile comparison happens at the same screen
 * coordinates. Only the bounded outer bands are ever scanned by the crop
 * analyzer, keeping the full-image 1024-long draw inexpensive.
 */
export function toCropRaster(image: HTMLImageElement): AnalysisRaster {
	return toAnalysisRaster(image, DEFAULT_CROP_ANALYSIS_MAX_DIM);
}
