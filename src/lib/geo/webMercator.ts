/**
 * A raster georeferenced by its Web Mercator (EPSG:3857) extent, as ArcGIS `exportImage` / `export` return it with
 * `imageSR=3857&f=json`. Pixels are square in mercator metres, and at course scale square on the ground too: one px
 * is (extent width / px width) x cos(latitude) ground metres in both axes.
 *
 * Why not `imageSR=4326`: the server keeps pixels square in DEGREES and grows the latitude extent to fit the
 * requested size, so a square request comes back vertically squeezed on the ground (by 1 / cos(latitude), 1.19 at
 * Dash's Track). The service's own returned extent is the only exact georeference, so it is recorded and used here.
 */

export const EARTH_RADIUS_M = 6378137;

export interface MercatorExtent {
	readonly xmin: number;
	readonly ymin: number;
	readonly xmax: number;
	readonly ymax: number;
}

export interface GeoRaster {
	/** EPSG:3857 metres, as returned by the service. */
	readonly extent: MercatorExtent;
	readonly widthPx: number;
	readonly heightPx: number;
}

export interface LonLat {
	readonly lat: number;
	readonly lon: number;
}

export function lonLatToMercator(point: LonLat): { x: number; y: number } {
	const lat = Math.max(-85.05112878, Math.min(85.05112878, point.lat));
	return {
		x: (EARTH_RADIUS_M * point.lon * Math.PI) / 180,
		y: EARTH_RADIUS_M * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))
	};
}

export function mercatorToLonLat(x: number, y: number): LonLat {
	return {
		lon: (x / EARTH_RADIUS_M) * (180 / Math.PI),
		lat: (2 * Math.atan(Math.exp(y / EARTH_RADIUS_M)) - Math.PI / 2) * (180 / Math.PI)
	};
}

/** Pixel (x right, y down, 0 at the top-left corner of the top-left pixel) to WGS84. */
export function pxToLonLat(raster: GeoRaster, xPx: number, yPx: number): LonLat {
	const { extent, widthPx, heightPx } = raster;
	return mercatorToLonLat(
		extent.xmin + (xPx / widthPx) * (extent.xmax - extent.xmin),
		extent.ymax - (yPx / heightPx) * (extent.ymax - extent.ymin)
	);
}

export function lonLatToPx(raster: GeoRaster, point: LonLat): { xPx: number; yPx: number } {
	const { extent, widthPx, heightPx } = raster;
	const m = lonLatToMercator(point);
	return {
		xPx: ((m.x - extent.xmin) / (extent.xmax - extent.xmin)) * widthPx,
		yPx: ((extent.ymax - m.y) / (extent.ymax - extent.ymin)) * heightPx
	};
}

/** Ground metres per px along each axis, at the raster's centre latitude. */
export function groundMetersPerPixel(raster: GeoRaster): { x: number; y: number; centre: LonLat } {
	const { extent, widthPx, heightPx } = raster;
	const centre = mercatorToLonLat((extent.xmin + extent.xmax) / 2, (extent.ymin + extent.ymax) / 2);
	const k = Math.cos((centre.lat * Math.PI) / 180);
	return { x: ((extent.xmax - extent.xmin) / widthPx) * k, y: ((extent.ymax - extent.ymin) / heightPx) * k, centre };
}

/** Great-circle distance in metres (haversine), for offsets between a searched and an adjusted centre. */
export function distanceMeters(a: LonLat, b: LonLat): number {
	const rad = Math.PI / 180;
	const dLat = (b.lat - a.lat) * rad;
	const dLon = (b.lon - a.lon) * rad;
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
	return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
}
