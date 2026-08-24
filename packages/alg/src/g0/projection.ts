// Tile→composite projection — one formula that used to be duplicated
// inline in two places in the page (src/routes/+page.svelte):
// projectMarkers() (~lines 167-221) and enterAnnotate()'s seed-building
// (~lines 693-733). Both computed the same thing:
//   composite.xPx = placement.x + (tileLocal.xPx - insets.left)
//   composite.yPx = placement.y + (tileLocal.yPx - insets.top)
// projectMarkers actually needed it applied twice over — once with a zero
// placement (to render a marker positioned within its own tile layer,
// which the viewport itself already places) and once with the tile's real
// placement (to compare two tiles' badges in shared composite-space for
// the "matched across tiles" highlight). Both are the same function now.
//
// OperationKind: 'compute' (deterministic coordinate arithmetic, no
// decision made).

import type { CropInsets } from '../raster';
import type { Placement } from './types';

export interface PixelPoint {
	readonly xPx: number;
	readonly yPx: number;
}

const ZERO_PLACEMENT: Placement = { x: 0, y: 0 };

/**
 * Project a point measured in the ORIGINAL (uncropped) tile's pixels into
 * composite-space: undo the crop inset, then add the tile's placement.
 * Pass `placement: {x:0,y:0}` (or omit it) to get crop-adjusted
 * tile-local coordinates instead of full composite coordinates.
 */
export function projectToComposite(
	point: PixelPoint,
	insets: CropInsets | null,
	placement: Placement = ZERO_PLACEMENT
): PixelPoint {
	const left = insets?.left ?? 0;
	const top = insets?.top ?? 0;
	return { xPx: placement.x + (point.xPx - left), yPx: placement.y + (point.yPx - top) };
}
