/**
 * ChainSpot course location search.
 *
 * Wraps the public OpenStreetMap Nominatim `search` endpoint
 * (`nominatim.openstreetmap.org/search`) so a user can find a course by name and
 * city/state instead of hunting down raw coordinates on an external map site
 * themselves. Free, public, no API key.
 *
 * Nominatim's usage policy (https://operations.osmfoundation.org/policies/nominatim/)
 * asks integrators to identify their application (a browser fetch satisfies this via
 * the request's own `Referer`, which is what every other browser-based Nominatim
 * client relies on — there is no way for page JavaScript to set a custom `User-Agent`
 * header), to stay well under one request per second, and to avoid live/auto-complete
 * queries. This module is deliberately called once per explicit user "Search" click
 * (never on keystroke), which satisfies all three without extra rate-limiting logic.
 * Results carry OpenStreetMap's ODbL attribution requirement — the caller must show
 * "© OpenStreetMap contributors" alongside any displayed result.
 *
 * Same typed-result convention as `src/lib/naip.ts`: failures are returned, not thrown.
 */

/** WGS84 point in decimal degrees. */
export interface GeoPoint {
	lat: number;
	lon: number;
}

/** One geocoding match: a human-readable place name plus its coordinate. */
export interface GeoSearchMatch extends GeoPoint {
	displayName: string;
}

const NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';

/** Matches returned per search, capped to keep the picker list scannable. */
export const GEOCODE_RESULT_LIMIT = 5;

export type GeocodeErrorKind = 'network' | 'http-error' | 'no-results';

export class GeocodeError extends Error {
	readonly kind: GeocodeErrorKind;

	constructor(kind: GeocodeErrorKind, message: string) {
		super(message);
		this.name = 'GeocodeError';
		this.kind = kind;
	}
}

export type GeocodeSearchResult =
	| { ok: true; matches: GeoSearchMatch[] }
	| { ok: false; error: GeocodeError };

export type FetchLike = typeof fetch;

/** Builds the Nominatim `search` URL for a free-text place query. */
export function buildNominatimSearchUrl(query: string, limit: number = GEOCODE_RESULT_LIMIT): string {
	const params = new URLSearchParams({
		q: query,
		format: 'jsonv2',
		limit: String(limit),
		addressdetails: '0',
		// The next step is USGS NAIP, which only covers the United States. Without
		// this constraint, a weak course-name match can select an unrelated place
		// overseas and produce a blank-looking aerial preview.
		countrycodes: 'us'
	});
	return `${NOMINATIM_SEARCH_URL}?${params.toString()}`;
}

interface NominatimResult {
	lat: string;
	lon: string;
	display_name: string;
}

function isNominatimResult(value: unknown): value is NominatimResult {
	if (typeof value !== 'object' || value === null) return false;
	const record = value as Record<string, unknown>;
	return typeof record.lat === 'string' && typeof record.lon === 'string' && typeof record.display_name === 'string';
}

/**
 * Searches for a place by free text (course name and city/state, joined by the
 * caller). Reports failure as a typed result — network error, non-200 status, or a
 * zero-length match array — rather than throwing, so the UI can render a clear
 * inline message instead of crashing.
 */
export async function searchPlace(
	query: string,
	options: { limit?: number; fetch?: FetchLike } = {}
): Promise<GeocodeSearchResult> {
	const { limit = GEOCODE_RESULT_LIMIT, fetch: fetchImpl = globalThis.fetch } = options;
	const url = buildNominatimSearchUrl(query, limit);

	let response: Response;
	try {
		response = await fetchImpl(url, { mode: 'cors' });
	} catch {
		return {
			ok: false,
			error: new GeocodeError(
				'network',
				'Could not reach the OpenStreetMap location search. Check your connection and try again.'
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
	const results = Array.isArray(body) ? body.filter(isNominatimResult) : [];
	if (results.length === 0) {
		return {
			ok: false,
			error: new GeocodeError(
				'no-results',
				'No matching location found. Try a different name, or enter coordinates manually below.'
			)
		};
	}

	const matches: GeoSearchMatch[] = results.map((result) => ({
		displayName: result.display_name,
		lat: Number(result.lat),
		lon: Number(result.lon)
	}));

	return { ok: true, matches };
}
