/**
 * Google Places API (New) geocoding provider.
 *
 * THE OWNER PRIORITIZES GOOGLE: Nominatim (see `./nominatim.ts`) only knows
 * things already mapped in OpenStreetMap, and most disc golf courses are not.
 * Google Places knows real-world POIs including disc golf courses, at the
 * cost of an API key — see `googleMapsApiKey` below for how that key is
 * resolved and gated. This provider is tried first by `../geocodeSearch.ts`;
 * Nominatim is the fallback.
 *
 * Mirrors the Nominatim provider's typed-result convention (failures
 * returned, not thrown) and the same `GeocodeMatch` output shape so the
 * downstream picker/satellite code never needs to know which provider
 * produced a result.
 *
 * US-constrained (`regionCode: 'us'`) for the same reason as Nominatim's own
 * `countrycodes: 'us'`: the next step downstream is a USGS NAIP fetch, which
 * only covers the United States, so a match outside it would only produce a
 * blank-looking aerial preview.
 *
 * Rederived from old-stuff/src/lib/placesSearch.ts and
 * old-stuff/src/lib/googleMapsConfig.ts.
 */
import { env } from '$env/dynamic/public';
import type { GeoBoundingBox } from '../satellite';
import type { GeocodeMatch, GeocodeResult, GeocodingProvider, FetchLike } from '../geocodeSearch';

const PLACES_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';

/** Matches requested per search; mirrors Nominatim's `GEOCODE_RESULT_LIMIT` so both providers cap the picker list the same way. */
export const PLACES_RESULT_LIMIT = 5;

/**
 * `places.viewport` rides the same response and the same billing SKU tier as
 * `places.location`, so requesting it adds zero calls and zero cost — it lets
 * a picked result size the aerial fetch to the place instead of a guessed
 * radius.
 */
const PLACES_FIELD_MASK = 'places.displayName,places.formattedAddress,places.location,places.viewport';

// ---------------------------------------------------------------------------
// API key resolution
// ---------------------------------------------------------------------------

/**
 * Test-only override: forces `googleMapsApiKey`/`googleMapsEnabled` to behave
 * as though the given key were configured (or, with `null`, as keyless),
 * bypassing `$env` entirely. `undefined` (the default) restores normal
 * env-based resolution. Application code never calls this.
 */
let testOverrideKey: string | null | undefined;

function resolveKey(): string | null {
	if (testOverrideKey !== undefined) return testOverrideKey;
	const raw = env.PUBLIC_GOOGLE_MAPS_API_KEY;
	return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
}

/** The configured Google Maps Platform key, or `null` when running keyless. */
export function googleMapsApiKey(): string | null {
	return resolveKey();
}

/** Test seam for `googleMapsApiKey` — see `testOverrideKey` above. */
export function setGoogleMapsApiKeyForTesting(key: string | null | undefined): void {
	testOverrideKey = key;
}

// ---------------------------------------------------------------------------
// Places API (New) searchText
// ---------------------------------------------------------------------------

export interface PlacesSearchRequestBody {
	readonly textQuery: string;
	readonly regionCode: string;
	readonly pageSize: number;
}

/** Builds the Places API (New) `searchText` request body for a free-text place query. */
export function buildPlacesSearchRequestBody(
	query: string,
	pageSize: number = PLACES_RESULT_LIMIT
): PlacesSearchRequestBody {
	return { textQuery: query, regionCode: 'us', pageSize };
}

interface PlacesApiLatLng {
	readonly latitude: number;
	readonly longitude: number;
}

interface PlacesApiPlace {
	readonly displayName: { readonly text: string };
	readonly formattedAddress?: string;
	readonly location: PlacesApiLatLng;
	/** Places API (New) viewport: low = south-west corner, high = north-east corner. */
	readonly viewport?: { readonly low?: unknown; readonly high?: unknown };
}

function isPlacesApiLatLng(value: unknown): value is PlacesApiLatLng {
	if (typeof value !== 'object' || value === null) return false;
	const record = value as Record<string, unknown>;
	return typeof record.latitude === 'number' && typeof record.longitude === 'number';
}

/**
 * Parses a place's optional `viewport` defensively into a `GeoBoundingBox`.
 * Malformed or inverted corners yield `undefined` — a bad box must never fail
 * an otherwise-good match (same rule as the Nominatim provider's parser).
 */
function parsePlacesViewport(place: PlacesApiPlace): GeoBoundingBox | undefined {
	const viewport = place.viewport;
	if (typeof viewport !== 'object' || viewport === null) return undefined;
	const { low, high } = viewport;
	if (!isPlacesApiLatLng(low) || !isPlacesApiLatLng(high)) return undefined;
	if (low.latitude > high.latitude || low.longitude > high.longitude) return undefined;
	return {
		minLat: low.latitude,
		maxLat: high.latitude,
		minLon: low.longitude,
		maxLon: high.longitude
	};
}

function isPlacesApiPlace(value: unknown): value is PlacesApiPlace {
	if (typeof value !== 'object' || value === null) return false;
	const record = value as Record<string, unknown>;

	const displayName = record.displayName;
	if (typeof displayName !== 'object' || displayName === null) return false;
	if (typeof (displayName as Record<string, unknown>).text !== 'string') return false;

	const location = record.location;
	if (typeof location !== 'object' || location === null) return false;
	const locationRecord = location as Record<string, unknown>;
	if (typeof locationRecord.latitude !== 'number' || typeof locationRecord.longitude !== 'number') return false;

	if (record.formattedAddress !== undefined && typeof record.formattedAddress !== 'string') return false;
	return true;
}

function isPlacesApiResponse(value: unknown): value is { places: unknown[] } {
	if (typeof value !== 'object' || value === null) return false;
	return Array.isArray((value as Record<string, unknown>).places);
}

/**
 * Searches for a place by free text (course name and city/state, joined by
 * the caller) via Google Places API (New) Text Search. Reports failure as a
 * typed result — network error, non-200 status, or a zero-length `places`
 * array — rather than throwing, so the UI can render a clear inline message
 * instead of crashing, and the caller (`../geocodeSearch.ts`) can fall
 * through to Nominatim.
 */
export async function searchGooglePlaces(
	query: string,
	apiKey: string,
	options: { pageSize?: number; fetch?: FetchLike } = {}
): Promise<GeocodeResult> {
	const { pageSize = PLACES_RESULT_LIMIT, fetch: fetchImpl = globalThis.fetch } = options;

	let response: Response;
	try {
		response = await fetchImpl(PLACES_SEARCH_URL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Goog-Api-Key': apiKey,
				'X-Goog-FieldMask': PLACES_FIELD_MASK
			},
			body: JSON.stringify(buildPlacesSearchRequestBody(query, pageSize))
		});
	} catch {
		return {
			ok: false,
			reason: 'Could not reach the Google Places location search. Check your connection and try again.'
		};
	}

	if (!response.ok) {
		return { ok: false, reason: `Location search returned an error (HTTP ${response.status}).` };
	}

	const body: unknown = await response.json();
	const places = isPlacesApiResponse(body) ? body.places.filter(isPlacesApiPlace) : [];
	if (places.length === 0) {
		return { ok: false, reason: 'No matching location found. Try a different name, or enter coordinates manually below.' };
	}

	const matches: GeocodeMatch[] = places.map((place) => {
		const viewport = parsePlacesViewport(place);
		return {
			displayName: place.formattedAddress
				? `${place.displayName.text}, ${place.formattedAddress}`
				: place.displayName.text,
			lat: place.location.latitude,
			lon: place.location.longitude,
			...(viewport ? { viewport } : {})
		};
	});

	return { ok: true, matches, providerName: 'google' };
}

/** Google Places geocoding provider: keyed, tried first — see module doc comment. */
export const googleProvider: GeocodingProvider = {
	name: 'google',
	available(): boolean {
		return resolveKey() !== null;
	},
	search(query: string): Promise<GeocodeResult> {
		const key = resolveKey();
		if (key === null) {
			return Promise.resolve({ ok: false, reason: 'Google Maps is not configured.' });
		}
		return searchGooglePlaces(query, key);
	}
};

// ---------------------------------------------------------------------------
// Coordinate-paste tolerance
// ---------------------------------------------------------------------------

export interface ParsedCoordinate {
	readonly lat: number;
	readonly lon: number;
}

/** "lat, lon" or "lat lon" — optional whitespace around a comma or bare whitespace separator. */
const BARE_COORDINATE_RE = /^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/;
/** A Google Maps URL's `@lat,lon,zoom` viewport segment, e.g. `.../@33.1255,-96.861,17z`. */
const AT_COORDINATE_RE = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/;
/** A Google Maps URL's `?q=lat,lon` (or `&q=lat,lon`) query parameter. */
const QUERY_COORDINATE_RE = /[?&]q=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/;

function toParsedCoordinate(latRaw: string, lonRaw: string): ParsedCoordinate | null {
	const lat = Number(latRaw);
	const lon = Number(lonRaw);
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
	if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
	return { lat, lon };
}

/**
 * Detects a pasted coordinate (typed lat/lon, or a Google Maps URL carrying
 * one) in free text, so the course-name search field can skip geocoding
 * entirely and treat it as an already-selected location. Only three shapes
 * are recognized, checked in this order: a bare "lat, lon" (or "lat lon")
 * pair, a Google Maps `@lat,lon,zoom` viewport segment, and a Google Maps
 * `?q=lat,lon` query parameter. Returns null for anything else (an ordinary
 * course-name search query, most of all), including out-of-range
 * latitude/longitude values.
 */
export function parseCoordinateInput(input: string): ParsedCoordinate | null {
	const trimmed = input.trim();
	if (!trimmed) return null;

	const bareMatch = trimmed.match(BARE_COORDINATE_RE);
	if (bareMatch) return toParsedCoordinate(bareMatch[1], bareMatch[2]);

	const atMatch = trimmed.match(AT_COORDINATE_RE);
	if (atMatch) return toParsedCoordinate(atMatch[1], atMatch[2]);

	const queryMatch = trimmed.match(QUERY_COORDINATE_RE);
	if (queryMatch) return toParsedCoordinate(queryMatch[1], queryMatch[2]);

	return null;
}
