import { afterEach, describe, expect, test, vi } from 'vitest';

// `google.ts` reads its API key via `$env/dynamic/public`, which is only
// resolvable through SvelteKit's Vite plugin (not configured in this
// project's plain `vitest.config.ts`). Stub it so the module graph resolves
// under vitest; every test below still drives the key through
// `setGoogleMapsApiKeyForTesting`, which takes precedence over this stub.
vi.mock('$env/dynamic/public', () => ({ env: {} }));

import { searchPlace, attributionFor, GEOCODING_PROVIDERS, parseCoordinateInput } from '$lib/geocodeSearch';
import { googleProvider, setGoogleMapsApiKeyForTesting, buildPlacesSearchRequestBody } from '$lib/geocoding/google';
import { nominatimProvider, buildNominatimSearchUrl } from '$lib/geocoding/nominatim';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
	return {
		ok,
		status,
		json: async () => body
	} as unknown as Response;
}

afterEach(() => {
	setGoogleMapsApiKeyForTesting(undefined);
	vi.restoreAllMocks();
});

describe('provider order', () => {
	test('GEOCODING_PROVIDERS lists google first', () => {
		expect(GEOCODING_PROVIDERS.map((p) => p.name)).toEqual(['google', 'nominatim']);
	});
});

describe('searchPlace', () => {
	test('uses Google when a key is configured and Google has matches', async () => {
		setGoogleMapsApiKeyForTesting('test-key');
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse({
				places: [
					{
						displayName: { text: 'Dash\'s Track' },
						formattedAddress: 'Somewhere, TX',
						location: { latitude: 33.1, longitude: -96.8 }
					}
				]
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		const result = await searchPlace('Dash\'s Track');
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.providerName).toBe('google');
			expect(result.matches[0].displayName).toContain('Dash\'s Track');
		}
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][0]).toBe('https://places.googleapis.com/v1/places:searchText');
	});

	test('skips Google when no key is configured, falls to Nominatim', async () => {
		setGoogleMapsApiKeyForTesting(null);
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse([{ lat: '45.5', lon: '-122.6', display_name: 'Portland, OR' }])
		);
		vi.stubGlobal('fetch', fetchMock);

		const result = await searchPlace('Portland');
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.providerName).toBe('nominatim');
		}
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0][0])).toContain('nominatim.openstreetmap.org');
	});

	test('falls through to Nominatim when Google returns zero matches', async () => {
		setGoogleMapsApiKeyForTesting('test-key');
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ places: [] }))
			.mockResolvedValueOnce(jsonResponse([{ lat: '45.5', lon: '-122.6', display_name: 'Portland, OR' }]));
		vi.stubGlobal('fetch', fetchMock);

		const result = await searchPlace('some obscure course');
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.providerName).toBe('nominatim');
		}
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	test('falls through to Nominatim when Google errors (network failure)', async () => {
		setGoogleMapsApiKeyForTesting('test-key');
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new Error('network down'))
			.mockResolvedValueOnce(jsonResponse([{ lat: '45.5', lon: '-122.6', display_name: 'Portland, OR' }]));
		vi.stubGlobal('fetch', fetchMock);

		const result = await searchPlace('Portland');
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.providerName).toBe('nominatim');
		}
	});

	test('returns failure when every provider fails', async () => {
		setGoogleMapsApiKeyForTesting(null);
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
		vi.stubGlobal('fetch', fetchMock);

		const result = await searchPlace('nowhere');
		expect(result.ok).toBe(false);
	});
});

describe('request/URL builders', () => {
	test('buildPlacesSearchRequestBody builds a US-scoped textQuery request', () => {
		expect(buildPlacesSearchRequestBody('Dash\'s Track')).toEqual({
			textQuery: 'Dash\'s Track',
			regionCode: 'us',
			pageSize: 5
		});
	});

	test('buildNominatimSearchUrl builds a US-scoped search URL', () => {
		const url = buildNominatimSearchUrl('Portland', 5);
		expect(url).toContain('nominatim.openstreetmap.org/search');
		expect(url).toContain('q=Portland');
		expect(url).toContain('countrycodes=us');
		expect(url).toContain('limit=5');
	});
});

describe('attributionFor', () => {
	test('google', () => {
		expect(attributionFor('google')).toBe('Google');
	});
	test('nominatim', () => {
		expect(attributionFor('nominatim')).toContain('OpenStreetMap');
	});
	test('unknown provider yields empty string', () => {
		expect(attributionFor('bogus')).toBe('');
	});
});

describe('provider.available()', () => {
	test('google available() reflects the configured key', () => {
		setGoogleMapsApiKeyForTesting('key');
		expect(googleProvider.available()).toBe(true);
		setGoogleMapsApiKeyForTesting(null);
		expect(googleProvider.available()).toBe(false);
	});

	test('nominatim available() is always true (keyless)', () => {
		expect(nominatimProvider.available()).toBe(true);
	});
});

describe('parseCoordinateInput', () => {
	test('plain "lat, lon"', () => {
		expect(parseCoordinateInput('33.1255, -96.861')).toEqual({ lat: 33.1255, lon: -96.861 });
	});

	test('plain "lat lon" (space-separated)', () => {
		expect(parseCoordinateInput('33.1255 -96.861')).toEqual({ lat: 33.1255, lon: -96.861 });
	});

	test('Google Maps URL with @lat,lon,zoom', () => {
		const url = 'https://www.google.com/maps/place/Some+Park/@33.1255,-96.861,17z/data=abc';
		expect(parseCoordinateInput(url)).toEqual({ lat: 33.1255, lon: -96.861 });
	});

	test('Google Maps URL with ?q=lat,lon', () => {
		const url = 'https://maps.google.com/maps?q=33.1255,-96.861';
		expect(parseCoordinateInput(url)).toEqual({ lat: 33.1255, lon: -96.861 });
	});

	test('garbage input returns null', () => {
		expect(parseCoordinateInput('Dash\'s Track, Frisco TX')).toBeNull();
	});

	test('out-of-range coordinates return null', () => {
		expect(parseCoordinateInput('200, -96.861')).toBeNull();
	});

	test('empty string returns null', () => {
		expect(parseCoordinateInput('   ')).toBeNull();
	});
});
