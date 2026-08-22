/**
 * ChainSpot satellite acquisition: bbox math, pixel<->geo mapping, and the
 * multi-provider federal-imagery fetch with fallback.
 *
 * Rederived from old-stuff/src/lib/naip.ts (bbox math), naipCoverage.ts
 * (viewport -> fetch geometry, pixel<->geo mapping), and aerialProviders.ts
 * (the multi-provider fallback fetch, kept as the ONLY fetch path — naip.ts's
 * own single-provider fetch is dropped). Mosaic/grid/edge-remap/refetch
 * machinery from the old modules is intentionally not carried over: this MVP
 * needs one raster in, correspondence points out.
 */

/** WGS84 point in decimal degrees. */
export interface GeoPoint {
	lat: number;
	lon: number;
}

/** WGS84 bounding box in decimal degrees. */
export interface GeoBoundingBox {
	minLon: number;
	minLat: number;
	maxLon: number;
	maxLat: number;
}

/** Meters per degree of latitude; treated as constant (adequate at course scale). */
export const METERS_PER_DEGREE_LAT = 111_320;

/**
 * Computes a WGS84 bounding box centered on `center`, extending `radiusMeters`
 * in every direction. Uses a simple equirectangular (flat-earth) approximation
 * — longitude degrees scaled by cos(latitude) — which is a coarse-scale
 * approximation: fine at disc-golf-course scale (tens to hundreds of meters),
 * not a substitute for real geodesy at larger extents.
 */
export function bboxFromCenter(center: GeoPoint, radiusMeters: number): GeoBoundingBox {
	if (!Number.isFinite(center.lat) || center.lat < -90 || center.lat > 90) {
		throw new Error(`bboxFromCenter: latitude must be a finite number in [-90, 90], got ${center.lat}`);
	}
	if (!Number.isFinite(center.lon) || center.lon < -180 || center.lon > 180) {
		throw new Error(`bboxFromCenter: longitude must be a finite number in [-180, 180], got ${center.lon}`);
	}
	if (!Number.isFinite(radiusMeters) || radiusMeters <= 0) {
		throw new Error(`bboxFromCenter: radiusMeters must be a positive finite number, got ${radiusMeters}`);
	}

	const latDegrees = radiusMeters / METERS_PER_DEGREE_LAT;
	const metersPerDegreeLon = METERS_PER_DEGREE_LAT * Math.cos((center.lat * Math.PI) / 180);
	// Guard the pole-adjacent degenerate case (cos ~ 0) rather than dividing
	// toward infinity; not a realistic input at course scale, but keeps this a
	// clean typed throw instead of a NaN bbox.
	const lonDegrees = metersPerDegreeLon > 1e-6 ? radiusMeters / metersPerDegreeLon : 180;

	return {
		minLon: center.lon - lonDegrees,
		maxLon: center.lon + lonDegrees,
		minLat: center.lat - latDegrees,
		maxLat: center.lat + latDegrees
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

/** Fallback radius when a geocoder result has no usable bounding box. */
export const DEFAULT_VIEWPORT_RADIUS_METERS = 300;
/** Boxes smaller than this across are point-defaults, not real place extents. */
export const MIN_USEFUL_VIEWPORT_METERS = 120;
/** Clamp bounds for a viewport-derived radius. */
export const MIN_VIEWPORT_RADIUS_METERS = 150;
export const MAX_VIEWPORT_RADIUS_METERS = 1500;
/** Breathing margin applied to a viewport-derived half-extent. */
export const VIEWPORT_RADIUS_MARGIN = 1.15;

export interface FetchGeometry {
	center: GeoPoint;
	radiusMeters: number;
	/** True when the radius came from a real provider box rather than the default. */
	fromViewport: boolean;
}

/**
 * Turns a geocoder result's bounding box (if any) into a fetch center/radius.
 * A missing or degenerate box (smaller than `MIN_USEFUL_VIEWPORT_METERS`
 * across — providers return point-default rectangles for unmapped POIs)
 * yields the result's own center at `DEFAULT_VIEWPORT_RADIUS_METERS` with
 * `fromViewport: false`.
 */
export function fetchGeometryFromViewport(
	resultCenter: GeoPoint,
	viewport: GeoBoundingBox | undefined
): FetchGeometry {
	if (!viewport) {
		return { center: resultCenter, radiusMeters: DEFAULT_VIEWPORT_RADIUS_METERS, fromViewport: false };
	}
	const { center, widthMeters, heightMeters } = geoBoxCenterAndSize(viewport);
	if (
		!Number.isFinite(widthMeters) ||
		!Number.isFinite(heightMeters) ||
		widthMeters < 0 ||
		heightMeters < 0 ||
		Math.max(widthMeters, heightMeters) < MIN_USEFUL_VIEWPORT_METERS
	) {
		return { center: resultCenter, radiusMeters: DEFAULT_VIEWPORT_RADIUS_METERS, fromViewport: false };
	}
	const radiusMeters = Math.min(
		MAX_VIEWPORT_RADIUS_METERS,
		Math.max(MIN_VIEWPORT_RADIUS_METERS, (Math.max(widthMeters, heightMeters) / 2) * VIEWPORT_RADIUS_MARGIN)
	);
	return { center, radiusMeters, fromViewport: true };
}

/** A raster's own pixel space (x right, y down, origin top-left). */
export interface PixelPoint {
	xPx: number;
	yPx: number;
}

/** A fetched raster: its geographic extent plus its pixel dimensions. */
export interface GeoRaster {
	bbox: GeoBoundingBox;
	widthPx: number;
	heightPx: number;
}

/**
 * Pixel -> WGS84 for a fetched raster. Linear across both axes: row 0 is the
 * bbox's north edge, column 0 is its west edge. Bounds-free on purpose — a
 * point slightly outside [0, widthPx] x [0, heightPx] still maps, since a
 * correspondence click can legitimately land a pixel off the raster edge.
 */
export function pixelToGeo(raster: GeoRaster, p: PixelPoint): GeoPoint {
	const { bbox, widthPx, heightPx } = raster;
	return {
		lon: bbox.minLon + (p.xPx / widthPx) * (bbox.maxLon - bbox.minLon),
		lat: bbox.maxLat - (p.yPx / heightPx) * (bbox.maxLat - bbox.minLat)
	};
}

/** WGS84 -> pixel for a fetched raster: the exact inverse of `pixelToGeo`. */
export function geoToPixel(raster: GeoRaster, point: GeoPoint): PixelPoint {
	const { bbox, widthPx, heightPx } = raster;
	return {
		xPx: ((point.lon - bbox.minLon) / (bbox.maxLon - bbox.minLon)) * widthPx,
		yPx: ((bbox.maxLat - point.lat) / (bbox.maxLat - bbox.minLat)) * heightPx
	};
}

// --- Multi-provider federal-imagery fetch, with fallback -------------------

export type AerialProviderId = 'usda-naip' | 'usgs-naip-plus' | 'usgs-naip' | 'usgs-imagery-only';

export interface AerialProvider {
	id: AerialProviderId;
	label: string;
	kind: 'image-server' | 'map-server';
	baseUrl: string;
	maxWidthPx: number;
	maxHeightPx: number;
}

/**
 * Provider order. USDA's public latest-NAIP ImageServer is first because it
 * advertises the largest export surface and WGS84-native coverage. The two
 * dynamic USGS ImageServers follow. USGSImageryOnly is last: it's a
 * compressed cached basemap, treated as locator/fallback imagery rather than
 * the clean-target quality ceiling.
 */
export const AERIAL_PROVIDERS: readonly AerialProvider[] = [
	{
		id: 'usda-naip',
		label: 'USDA latest NAIP',
		kind: 'image-server',
		baseUrl: 'https://apps.geo.fpac.usda.gov/geo-imagery/rest/services/naip/conus_naip/ImageServer/exportImage',
		maxWidthPx: 15000,
		maxHeightPx: 4100
	},
	{
		id: 'usgs-naip-plus',
		label: 'USGS NAIP Plus / HRO',
		kind: 'image-server',
		baseUrl: 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage',
		maxWidthPx: 4000,
		maxHeightPx: 4000
	},
	{
		id: 'usgs-naip',
		label: 'USGS NAIP',
		kind: 'image-server',
		baseUrl: 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage',
		maxWidthPx: 4000,
		maxHeightPx: 4000
	},
	{
		id: 'usgs-imagery-only',
		label: 'USGS ImageryOnly cached fallback',
		kind: 'map-server',
		baseUrl: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/export',
		maxWidthPx: 4096,
		maxHeightPx: 4096
	}
];

/** Builds one provider's direct image-response URL, WGS84 in and out. */
export function buildAerialExportUrl(provider: AerialProvider, bbox: GeoBoundingBox, sizePx: number): string {
	if (!Number.isInteger(sizePx) || sizePx <= 0) {
		throw new Error(`buildAerialExportUrl: sizePx must be a positive integer, got ${sizePx}`);
	}
	if (sizePx > provider.maxWidthPx || sizePx > provider.maxHeightPx) {
		throw new Error(
			`${provider.label} caps exports at ${provider.maxWidthPx} x ${provider.maxHeightPx}; requested ${sizePx} x ${sizePx}.`
		);
	}
	const params = new URLSearchParams({
		bbox: `${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat}`,
		bboxSR: '4326',
		imageSR: '4326',
		size: `${sizePx},${sizePx}`,
		format: provider.kind === 'map-server' ? 'png32' : 'png',
		f: 'image'
	});
	return `${provider.baseUrl}?${params.toString()}`;
}

export interface AerialFetchAttempt {
	providerId: AerialProviderId;
	url: string;
	kind: 'cors-or-network' | 'http-error' | 'bad-content-type';
	message: string;
}

export type AerialFetchResult =
	| { ok: true; blob: Blob; provider: string; bbox: GeoBoundingBox; widthPx: number; heightPx: number }
	| { ok: false; attempts: readonly AerialFetchAttempt[] };

export type FetchLike = typeof fetch;

/**
 * Fetches a satellite raster for `bbox`, trying each configured provider in
 * order until one returns browser-readable image bytes. A fetch TypeError
 * cannot distinguish CORS rejection from a real network failure, so that
 * category is reported honestly as `cors-or-network` and the loop proceeds to
 * the next provider.
 */
export async function fetchSatellite(
	bbox: GeoBoundingBox,
	sizePx: number,
	options: { fetch?: FetchLike; providers?: readonly AerialProvider[] } = {}
): Promise<AerialFetchResult> {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const providers = options.providers ?? AERIAL_PROVIDERS;
	const attempts: AerialFetchAttempt[] = [];

	for (const provider of providers) {
		let url: string;
		try {
			url = buildAerialExportUrl(provider, bbox, sizePx);
		} catch (error) {
			attempts.push({
				providerId: provider.id,
				url: provider.baseUrl,
				kind: 'http-error',
				message: error instanceof Error ? error.message : String(error)
			});
			continue;
		}

		let response: Response;
		try {
			response = await fetchImpl(url, { mode: 'cors' });
		} catch {
			attempts.push({
				providerId: provider.id,
				url,
				kind: 'cors-or-network',
				message: 'Browser could not read the response (CORS rejection or network failure).'
			});
			continue;
		}

		if (!response.ok) {
			attempts.push({ providerId: provider.id, url, kind: 'http-error', message: `HTTP ${response.status}` });
			continue;
		}

		const contentType = response.headers.get('content-type') ?? '';
		if (!contentType.toLowerCase().startsWith('image/')) {
			attempts.push({
				providerId: provider.id,
				url,
				kind: 'bad-content-type',
				message: `Expected image bytes, got ${contentType || 'unknown content type'}.`
			});
			continue;
		}

		const blob = await response.blob();
		return { ok: true, blob, provider: provider.id, bbox, widthPx: sizePx, heightPx: sizePx };
	}

	return { ok: false, attempts };
}
