/**
 * ChainSpot NAIP tile-grid planning.
 *
 * Pure geometry: converts a user-drawn pixel rectangle on a reference NAIP preview
 * into a geographic box, then plans a grid of tile centers that covers that box at a
 * fixed per-tile radius. No image content is inspected and no cross-tile matching
 * happens anywhere in this module — placement correctness comes from the same bbox
 * arithmetic `naip.ts` already uses to build each tile's own request. Unlike the
 * Stitch Map screenshot compositor (`src/lib/stitch/`), which has to *discover*
 * alignment because screenshots carry no known pixel-to-world mapping, every NAIP
 * tile's geographic extent is chosen before any network call happens, so there is
 * nothing here to trust beyond arithmetic.
 */
import { offsetPoint, METERS_PER_DEGREE_LAT } from './naip';
import type { GeoBoundingBox, GeoPoint } from './naip';

/** A rectangle in image pixel coordinates (origin top-left, y grows downward). */
export interface PixelRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Converts a pixel rectangle drawn over a square reference image into its geographic
 * box. The reference image's own bbox maps linearly across its pixel dimensions
 * because `exportImage` resamples into exactly the requested raster shape regardless
 * of the bbox's real-world aspect ratio — the same assumption `buildNaipExportUrl`
 * relies on when it requests a square `size` for a (near-)square bbox.
 */
export function pixelRectToGeoBox(
	referenceBbox: GeoBoundingBox,
	referenceSizePx: number,
	rect: PixelRect
): GeoBoundingBox {
	const lonAt = (px: number) =>
		referenceBbox.minLon + (px / referenceSizePx) * (referenceBbox.maxLon - referenceBbox.minLon);
	const latAt = (py: number) =>
		referenceBbox.maxLat - (py / referenceSizePx) * (referenceBbox.maxLat - referenceBbox.minLat);
	return {
		minLon: lonAt(rect.x),
		maxLon: lonAt(rect.x + rect.width),
		minLat: latAt(rect.y + rect.height),
		maxLat: latAt(rect.y)
	};
}

/** Center point and physical width/height (meters) of a geographic box. */
export function geoBoxCenterAndSize(box: GeoBoundingBox): {
	center: GeoPoint;
	widthMeters: number;
	heightMeters: number;
} {
	const center: GeoPoint = { lat: (box.minLat + box.maxLat) / 2, lon: (box.minLon + box.maxLon) / 2 };
	const metersPerDegreeLon = METERS_PER_DEGREE_LAT * Math.cos((center.lat * Math.PI) / 180);
	return {
		center,
		widthMeters: (box.maxLon - box.minLon) * metersPerDegreeLon,
		heightMeters: (box.maxLat - box.minLat) * METERS_PER_DEGREE_LAT
	};
}

export interface TileGridPlan {
	rows: number;
	cols: number;
	tileRadiusMeters: number;
	/** Row-major tile centers (row 0 = northernmost), length `rows * cols`. */
	centers: GeoPoint[];
}

/**
 * Grid dimensions are capped so a large box selection degrades to a capped-but-still-
 * centered grid instead of an unbounded number of NAIP requests.
 */
export const MAX_GRID_ROWS = 5;
export const MAX_GRID_COLS = 5;

/**
 * Plans the smallest grid of `tileRadiusMeters`-radius tiles, centered on `center`,
 * that covers a `widthMeters` x `heightMeters` area. Adjacent tiles are spaced exactly
 * `2 * tileRadiusMeters` apart so they butt edge-to-edge with neither gap nor overlap
 * once each is fetched at that same radius and placed at its computed offset.
 */
export function planTileGrid(
	center: GeoPoint,
	widthMeters: number,
	heightMeters: number,
	tileRadiusMeters: number
): TileGridPlan {
	if (!(tileRadiusMeters > 0)) {
		throw new Error(`planTileGrid: tileRadiusMeters must be positive, got ${tileRadiusMeters}`);
	}
	const tileSpanMeters = tileRadiusMeters * 2;
	const cols = Math.min(MAX_GRID_COLS, Math.max(1, Math.ceil(widthMeters / tileSpanMeters)));
	const rows = Math.min(MAX_GRID_ROWS, Math.max(1, Math.ceil(heightMeters / tileSpanMeters)));

	const centers: GeoPoint[] = [];
	for (let row = 0; row < rows; row++) {
		const dyMeters = ((rows - 1) / 2 - row) * tileSpanMeters;
		for (let col = 0; col < cols; col++) {
			const dxMeters = (col - (cols - 1) / 2) * tileSpanMeters;
			centers.push(offsetPoint(center, dxMeters, dyMeters));
		}
	}
	return { rows, cols, tileRadiusMeters, centers };
}
