/**
 * ChainSpot course location search: provider-agnostic front door.
 *
 * Owns the shared `GeocodeMatch`/`GeocodeResult` contract and the
 * `GeocodingProvider` interface that concrete providers implement, plus
 * `searchPlace`, which tries providers in priority order and returns the
 * first one that answers with matches.
 *
 * THE OWNER PRIORITIZES GOOGLE: `GEOCODING_PROVIDERS` lists Google first.
 * Nominatim (OpenStreetMap) lacks several disc golf courses that Google
 * Places knows about, so it is demoted to a fallback used only when Google
 * is unavailable (no API key configured) or comes back with zero matches or
 * an error.
 *
 * Concrete providers live in `./geocoding/google.ts` and
 * `./geocoding/nominatim.ts` — this module never talks to either API
 * directly, so it stays free of `fetch`/`$env` concerns.
 */

import type { GeoBoundingBox } from './satellite';

/** One geocoding match: a human-readable place name plus its coordinate. */
export interface GeocodeMatch {
	lat: number;
	lon: number;
	displayName: string;
	/**
	 * The provider's bounding box for the place, when it supplied one. Arrives
	 * in the SAME response as the match itself (e.g. Nominatim's
	 * `boundingbox` field, or Places API's `viewport`) — never via an extra
	 * request. Optional and best-effort: for point-only features a provider
	 * may return a degenerate box or none at all, so consumers must treat
	 * absence (and tiny boxes) as "size unknown".
	 */
	viewport?: GeoBoundingBox;
}

export type GeocodeResult =
	| { ok: true; matches: GeocodeMatch[]; providerName: string }
	| { ok: false; reason: string };

/** Back-compat alias: the pre-provider-interface name for {@link GeocodeResult}. */
export type GeocodeSearchResult = GeocodeResult;

export type FetchLike = typeof fetch;

/** A pluggable geocoding backend. See `./geocoding/google.ts` and `./geocoding/nominatim.ts`. */
export interface GeocodingProvider {
	/** Stable identifier, also used as the `providerName` on a successful result and by `attributionFor`. */
	readonly name: string;
	/** Whether this provider is currently usable (e.g. an API key is configured). Checked before every search. */
	available(): boolean;
	/** Searches for a place by free text. Must never throw — report failure via `{ ok: false, reason }`. */
	search(query: string): Promise<GeocodeResult>;
}

// Imported after the shared types above so `./geocoding/*` can import them
// back from this module without a circular-value dependency (only types
// cross the cycle, which TypeScript/Vite erase at build time).
import { googleProvider } from './geocoding/google';
import { nominatimProvider } from './geocoding/nominatim';

export { googleProvider } from './geocoding/google';
export { nominatimProvider } from './geocoding/nominatim';
export { parseCoordinateInput, type ParsedCoordinate } from './geocoding/google';

/** Matches returned per search, capped to keep the picker list scannable. Shared default for providers that don't set their own. */
export const GEOCODE_RESULT_LIMIT = 5;

/** Providers tried in order by `searchPlace`. Google first — see module doc comment. */
export const GEOCODING_PROVIDERS: GeocodingProvider[] = [googleProvider, nominatimProvider];

/**
 * Searches for a place by free text (course name and city/state, joined by
 * the caller), trying `GEOCODING_PROVIDERS` in order. A provider is skipped
 * when `available()` is false (e.g. no Google API key configured). The first
 * provider that returns `{ ok: true }` with at least one match wins; a
 * provider that errors or returns zero matches is skipped and the next one
 * is tried. If every provider is unavailable or fails, returns the last
 * failure's reason (or a generic message if none were even available).
 */
export async function searchPlace(query: string, providers: GeocodingProvider[] = GEOCODING_PROVIDERS): Promise<GeocodeResult> {
	let lastFailure: GeocodeResult | undefined;

	for (const provider of providers) {
		if (!provider.available()) continue;

		const result = await provider.search(query);
		if (result.ok && result.matches.length > 0) {
			return result;
		}
		lastFailure = result.ok ? { ok: false, reason: 'No matching location found.' } : result;
	}

	return lastFailure ?? { ok: false, reason: 'No location search provider is currently available.' };
}

/** Attribution strings required by each provider's terms of use, for the UI to render alongside results. */
const PROVIDER_ATTRIBUTION: Record<string, string> = {
	google: 'Google',
	nominatim: '© OpenStreetMap contributors'
};

/** The required UI attribution string for a given provider name (see `PROVIDER_ATTRIBUTION`), or `''` if unknown. */
export function attributionFor(providerName: string): string {
	return PROVIDER_ATTRIBUTION[providerName] ?? '';
}
