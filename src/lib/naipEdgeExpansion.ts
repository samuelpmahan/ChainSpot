import { NAIP_EXPORT_SIZE_PX } from './naip';
import { expandedFetchGeometry } from './naipCoverage';
import type { NaipFetchGeometry, PixelBounds } from './naipCoverage';
import type { EdgeDirection } from './edgeLoadZones';

/**
 * Pixel-space bounds representing the current raster plus one full adjacent
 * raster in the requested direction. `expandedFetchGeometry` then converts
 * that union through the existing pixel→WGS84 machinery, so no new geo math
 * is introduced here.
 */
export function directionalExpansionBounds(
	direction: EdgeDirection,
	sizePx: number = NAIP_EXPORT_SIZE_PX
): PixelBounds {
	if (!Number.isFinite(sizePx) || sizePx <= 0) {
		throw new Error(`directionalExpansionBounds: sizePx must be positive and finite, got ${sizePx}`);
	}
	switch (direction) {
		case 'north':
			return { minX: 0, minY: -sizePx, maxX: sizePx, maxY: sizePx };
		case 'east':
			return { minX: 0, minY: 0, maxX: sizePx * 2, maxY: sizePx };
		case 'south':
			return { minX: 0, minY: 0, maxX: sizePx, maxY: sizePx * 2 };
		case 'west':
			return { minX: -sizePx, minY: 0, maxX: sizePx, maxY: sizePx };
	}
}

/**
 * Expands a north-up radius fetch far enough to retain the ENTIRE current
 * raster plus one neighboring raster in `direction`. A small 5% margin avoids
 * edge-rounding surprises without the larger 10% safety margin used by the
 * automatic whole-course recovery path.
 */
export function expandedFetchGeometryToward(
	oldGeometry: NaipFetchGeometry,
	direction: EdgeDirection,
	options: { sizePx?: number; marginFraction?: number } = {}
): NaipFetchGeometry {
	const sizePx = options.sizePx ?? NAIP_EXPORT_SIZE_PX;
	return expandedFetchGeometry(oldGeometry, directionalExpansionBounds(direction, sizePx), {
		sizePx,
		marginFraction: options.marginFraction ?? 0.05
	});
}
