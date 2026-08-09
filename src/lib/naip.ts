/**
 * ChainSpot NAIP aerial fetch (Phase 3a).
 *
 * Wraps the public USGS NAIP `exportImage` REST endpoint
 * (`imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer`) as an
 * isolated, provider-specific module per the overarching plan's guidance to isolate
 * imagery acquisition behind a provider interface. Free, public-domain, CORS-enabled,
 * no API key.
 *
 * Two pure pieces (bbox math, URL construction) plus one network call. The fetch
 * reports failure as a typed result, never a thrown exception, following the same
 * `{ ok: true | false }` convention as `src/lib/stitch/smartImport.ts` so callers can
 * render a clear inline error instead of crashing.
 */

/** WGS84 center point in decimal degrees. */
export interface GeoPoint {
	lat: number;
	lon: number;
}

/** A WGS84 bounding box in decimal degrees. */
export interface GeoBoundingBox {
	minLon: number;
	minLat: number;
	maxLon: number;
	maxLat: number;
}

/** Meters per degree of latitude; treated as constant (adequate at course scale). */
export const METERS_PER_DEGREE_LAT = 111_320;

/** Default raster size (pixels per side) requested from `exportImage`. */
export const NAIP_EXPORT_SIZE_PX = 2048;

const NAIP_EXPORT_IMAGE_URL =
	'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage';

/**
 * Computes a WGS84 bounding box centered on `center`, extending `radiusMeters` in
 * every direction. Uses a simple equirectangular (flat-earth) approximation —
 * longitude degrees are scaled by `cos(latitude)` — which is entirely adequate at
 * disc-golf-course scale (a few hundred meters) and avoids pulling in a real geodesy
 * library for a correction that would be sub-meter here.
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
	// Guard the pole-adjacent degenerate case (cos ~ 0) rather than dividing toward
	// infinity; disc-golf courses are never near a pole, but the guard keeps this a
	// clean typed throw instead of a NaN bbox.
	const lonDegrees =
		metersPerDegreeLon > 1e-6 ? radiusMeters / metersPerDegreeLon : 180;

	return {
		minLon: center.lon - lonDegrees,
		maxLon: center.lon + lonDegrees,
		minLat: center.lat - latDegrees,
		maxLat: center.lat + latDegrees
	};
}

/**
 * Builds the `exportImage` URL for a bounding box: WGS84 input (`bboxSR=4326`),
 * an explicit raster size, PNG, and `f=image` so the endpoint returns raw PNG bytes
 * directly rather than a JSON wrapper. A numeric size remains the square-output
 * shorthand used by the radius-based preview and tile workflows.
 */
export function buildNaipExportUrl(
	bbox: GeoBoundingBox,
	sizePx: number | NaipRasterSize = NAIP_EXPORT_SIZE_PX
): string {
	const size = rasterSize(sizePx);
	const params = new URLSearchParams({
		bbox: `${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat}`,
		bboxSR: '4326',
		size: `${size.widthPx},${size.heightPx}`,
		format: 'png',
		f: 'image'
	});
	return `${NAIP_EXPORT_IMAGE_URL}?${params.toString()}`;
}

/**
 * Offsets `center` by a flat-earth displacement in meters (east-positive `dxMeters`,
 * north-positive `dyMeters`), using the same equirectangular approximation as
 * `bboxFromCenter` — adequate at course scale, and kept consistent with it so a grid
 * of tiles built from repeated offsets lines up with any single tile's own bbox math.
 */
export function offsetPoint(center: GeoPoint, dxMeters: number, dyMeters: number): GeoPoint {
	const metersPerDegreeLon = METERS_PER_DEGREE_LAT * Math.cos((center.lat * Math.PI) / 180);
	const lonPerMeter = metersPerDegreeLon > 1e-6 ? 1 / metersPerDegreeLon : 0;
	return {
		lat: center.lat + dyMeters / METERS_PER_DEGREE_LAT,
		lon: center.lon + dxMeters * lonPerMeter
	};
}

/**
 * Ground resolution of a fetched `exportImage` raster: the request bbox spans exactly
 * `2 * radiusMeters` on each side (by construction of `bboxFromCenter`, square at
 * course scale) and `exportImage` returns exactly `sizePx x sizePx` pixels for a
 * square bbox and a square requested size — no letterboxing, no resampling to a
 * different aspect. The scale is therefore exact, not estimated.
 */
export function naipMetersPerPixel(radiusMeters: number, sizePx: number = NAIP_EXPORT_SIZE_PX): number {
	if (!Number.isFinite(radiusMeters) || radiusMeters <= 0) {
		throw new Error(`naipMetersPerPixel: radiusMeters must be a positive finite number, got ${radiusMeters}`);
	}
	if (!Number.isFinite(sizePx) || sizePx <= 0) {
		throw new Error(`naipMetersPerPixel: sizePx must be a positive finite number, got ${sizePx}`);
	}
	return (2 * radiusMeters) / sizePx;
}

export type NaipFetchErrorKind = 'network' | 'http-error' | 'bad-content-type';

export class NaipFetchError extends Error {
	readonly kind: NaipFetchErrorKind;

	constructor(kind: NaipFetchErrorKind, message: string) {
		super(message);
		this.name = 'NaipFetchError';
		this.kind = kind;
	}
}

export type NaipFetchResult =
	| { ok: true; blob: Blob; url: string }
	| { ok: false; error: NaipFetchError };

export type FetchLike = typeof fetch;

export interface NaipRasterSize {
	widthPx: number;
	heightPx: number;
}

function rasterSize(size: number | NaipRasterSize): NaipRasterSize {
	const dimensions = typeof size === 'number' ? { widthPx: size, heightPx: size } : size;
	if (
		!Number.isInteger(dimensions.widthPx) ||
		!Number.isInteger(dimensions.heightPx) ||
		dimensions.widthPx <= 0 ||
		dimensions.heightPx <= 0
	) {
		throw new Error(
			`NAIP raster dimensions must be positive integers, got ${dimensions.widthPx} x ${dimensions.heightPx}.`
		);
	}
	return dimensions;
}

/**
 * Fetches an image for an exact geographic bounding box. Rectangular output is
 * supported so a user-selected area can be fetched without padding it to a fixed
 * tile radius or stretching it into a square.
 */
export async function fetchNaipBoundingBoxImage(
	bbox: GeoBoundingBox,
	options: { widthPx?: number; heightPx?: number; fetch?: FetchLike } = {}
): Promise<NaipFetchResult> {
	const {
		widthPx = NAIP_EXPORT_SIZE_PX,
		heightPx = NAIP_EXPORT_SIZE_PX,
		fetch: fetchImpl = globalThis.fetch
	} = options;
	const size = rasterSize({ widthPx, heightPx });
	const url = buildNaipExportUrl(bbox, size);

	let response: Response;
	try {
		response = await fetchImpl(url, { mode: 'cors' });
	} catch {
		return {
			ok: false,
			error: new NaipFetchError(
				'network',
				'Could not reach the USGS NAIP imagery service. Check your connection and try again.'
			)
		};
	}

	if (!response.ok) {
		return {
			ok: false,
			error: new NaipFetchError(
				'http-error',
				`USGS NAIP imagery service returned an error (HTTP ${response.status}).`
			)
		};
	}

	const contentType = response.headers.get('content-type') ?? '';
	if (!contentType.toLowerCase().startsWith('image/')) {
		return {
			ok: false,
			error: new NaipFetchError(
				'bad-content-type',
				'No aerial imagery is available at this location and area. Try a nearby coordinate or a larger selection.'
			)
		};
	}

	return { ok: true, blob: await response.blob(), url };
}

/**
 * Fetches the NAIP `exportImage` PNG for a center point and radius. Reports failure
 * as a typed result (network error, non-200 status, or a response whose
 * `Content-Type` isn't an image — NAIP's `exportImage` returns a JSON error body with
 * a 200 status for some invalid requests, e.g. no coverage at the location) rather
 * than throwing, so the UI can render a clear inline message.
 */
export async function fetchNaipImage(
	center: GeoPoint,
	radiusMeters: number,
	options: { sizePx?: number; fetch?: FetchLike } = {}
): Promise<NaipFetchResult> {
	const bbox = bboxFromCenter(center, radiusMeters);
	return fetchNaipBoundingBoxImage(bbox, {
		widthPx: options.sizePx,
		heightPx: options.sizePx,
		fetch: options.fetch
	});
}
