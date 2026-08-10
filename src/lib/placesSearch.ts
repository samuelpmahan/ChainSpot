/**
 * ChainSpot course location search via Google Places API (New) Text Search.
 *
 * The keyed upgrade path over `geocode.ts`'s Nominatim wrapper: Nominatim
 * only knows things already mapped in OpenStreetMap, and most disc golf
 * courses ("Dash's Track" is the motivating example) are not. Google Places
 * knows real-world POIs including disc golf courses, at the cost of an API
 * key — see `googleMapsConfig.ts` for how that key is resolved and gated.
 *
 * Deliberately mirrors `geocode.ts` exactly: same typed-result convention
 * (failures returned, not thrown), same `GeoSearchMatch` output shape so the
 * downstream picker/NAIP code in `create-graphics/+page.svelte` never needs
 * to know which provider produced a result, and — reusing `geocode.ts`'s own
 * `GeocodeError`/`GeocodeSearchResult` types rather than duplicating them —
 * the exact same error-kind vocabulary (`network` / `http-error` /
 * `no-results`), just with messages that don't say "Nominatim".
 *
 * US-constrained (`regionCode: 'us'`) for the same reason as Nominatim's own
 * `countrycodes: 'us'`: the next step downstream is a USGS NAIP fetch, which
 * only covers the United States, so a match outside it would only produce a
 * blank-looking aerial preview.
 *
 * This module never fires on its own — see `create-graphics/+page.svelte`'s
 * `handleGeocodeSearch`, which calls it only on an explicit Search click,
 * matching `geocode.ts`'s own once-per-click discipline and the zero-Google-
 * at-page-load / one-Places-call-per-click ground rules in
 * `docs/google-maps-setup.md`.
 */
import { GeocodeError } from './geocode';
import type { GeoSearchMatch, GeocodeSearchResult } from './geocode';

const PLACES_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';

/** Matches requested per search; mirrors `geocode.ts`'s `GEOCODE_RESULT_LIMIT` so both providers cap the picker list the same way. */
export const PLACES_RESULT_LIMIT = 5;

const PLACES_FIELD_MASK = 'places.displayName,places.formattedAddress,places.location';

export type FetchLike = typeof fetch;

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

interface PlacesApiPlace {
	readonly displayName: { readonly text: string };
	readonly formattedAddress?: string;
	readonly location: { readonly latitude: number; readonly longitude: number };
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
 * the caller — same convention as `geocode.ts`'s `searchPlace`) via Google
 * Places API (New) Text Search. Reports failure as a typed `GeocodeSearchResult`
 * — network error, non-200 status, or a zero-length `places` array — rather
 * than throwing, so the UI can render a clear inline message instead of
 * crashing, and can distinguish `no-results` to try a Nominatim fallback.
 */
export async function searchPlacesText(
	query: string,
	apiKey: string,
	options: { pageSize?: number; fetch?: FetchLike } = {}
): Promise<GeocodeSearchResult> {
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
			error: new GeocodeError(
				'network',
				'Could not reach the Google Places location search. Check your connection and try again.'
			)
		};
	}

	if (!response.ok) {
		return {
			ok: false,
			error: new GeocodeError('http-error', `Location search returned an error (HTTP ${response.status}).`)
		};
	}

	const body: unknown = await response.json();
	const places = isPlacesApiResponse(body) ? body.places.filter(isPlacesApiPlace) : [];
	if (places.length === 0) {
		return {
			ok: false,
			error: new GeocodeError(
				'no-results',
				'No matching location found. Try a different name, or enter coordinates manually below.'
			)
		};
	}

	const matches: GeoSearchMatch[] = places.map((place) => ({
		displayName: place.formattedAddress ? `${place.displayName.text}, ${place.formattedAddress}` : place.displayName.text,
		lat: place.location.latitude,
		lon: place.location.longitude
	}));

	return { ok: true, matches };
}

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
 * one) in free text, so the create-graphics course-name search field can
 * skip geocoding entirely and treat it as an already-selected location. Only
 * three shapes are recognized, checked in this order: a bare "lat, lon" (or
 * "lat lon") pair, a Google Maps `@lat,lon,zoom` viewport segment, and a
 * Google Maps `?q=lat,lon` query parameter. Returns null for anything else
 * (an ordinary course-name search query, most of all), including
 * out-of-range latitude/longitude values.
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
