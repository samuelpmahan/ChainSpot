// Crop APPLY — the second half of auto-crop. proposeSharedCrop (autoCrop.ts)
// already does the MEASURE (propose shared chrome insets from N>=2
// same-sized rasters); this file extracts the APPLY step that used to live
// inline in the page's analyze() (src/routes/+page.svelte, ~lines 511-540):
// crop every raster to the proposal, AND — the load-bearing part easy to
// miss — shift every tile's placement by the same (left, top) so
// composite-space coordinates recorded before the crop (e.g. the initial
// spread layout) stay consistent with the now-smaller rasters after it.
//
// OperationKind: 'transform' (the propose step in autoCrop.ts is 'measure').

import type { CropInsets, GrayRaster } from '../raster';
import { cropRaster } from '../raster';
import { proposeSharedCrop } from '../autoCrop';
import type { Placement } from './types';

export interface CropApplyResult {
	/** null when no crop was proposed (or skipped) — rasters/placements pass through unchanged. */
	readonly insets: CropInsets | null;
	readonly rasters: readonly GrayRaster[];
	readonly placements: readonly Placement[];
}

export function applyCrop(
	rasters: readonly GrayRaster[],
	placements: readonly Placement[],
	options?: { readonly skip?: boolean }
): CropApplyResult {
	const proposal = options?.skip ? null : proposeSharedCrop(rasters.slice());
	if (!proposal) return { insets: null, rasters, placements };

	return {
		insets: proposal,
		rasters: rasters.map((raster) => cropRaster(raster, proposal)),
		placements: placements.map((p) => ({ x: p.x + proposal.left, y: p.y + proposal.top }))
	};
}
