/**
 * Shared crop gating rules (P1-002, matcher-region hardening).
 *
 * `matcherRegionFromCrop` decides when matcher rasters (the stitch-matching
 * comparison, not the crop detector itself) are trimmed to a confidently
 * cropped interior before pairwise scoring. Only `high` crop confidence is
 * trusted: the same numeric inset removed from all four tiles is a constant
 * offset that cancels out of any pair's relative translation regardless of
 * correctness, but a `low`-confidence boundary can be genuinely unresolved or
 * partial (see `autoCrop.ts`), and trimming by an unresolved amount could eat
 * into the thin real overlap band the matcher depends on. Absent a
 * high-confidence proposal, matcher rasters keep sampling the whole frame.
 *
 * Crop confidence is otherwise independent of layout confidence: whatever
 * crop evidence `autoCrop.ts` produces is surfaced to the user as-is, with no
 * separate gating on the layout diagnostic (see call sites in
 * `smartImport.ts` and `smartStitch.worker.ts`).
 */
import type { CropProposalDetail } from './autoCrop';
import type { RasterRegion } from './analysis';

/**
 * The interior sub-region matcher rasters should be built from, given one
 * tile's own original dimensions and the (shared) crop evidence. Returns null
 * when the crop is anything less than `high` confidence, so matcher raster
 * construction falls back to today's full-frame behavior unchanged.
 */
export function matcherRegionFromCrop(
	crop: CropProposalDetail | null,
	widthPx: number,
	heightPx: number
): RasterRegion | null {
	if (!crop || crop.confidence !== 'high' || !crop.insets) return null;
	const { topPx, rightPx, bottomPx, leftPx } = crop.insets;
	return {
		x: leftPx,
		y: topPx,
		width: widthPx - leftPx - rightPx,
		height: heightPx - topPx - bottomPx
	};
}
