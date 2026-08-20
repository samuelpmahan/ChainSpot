import { describe, expect, test } from 'vitest';
import { buildNominatimSearchUrl, searchPlace, GEOCODE_RESULT_LIMIT } from '../../src/lib/geocode';
import type { FetchLike } from '../../src/lib/geocode';

describe('buildNominatimSearchUrl', () => {
	test('encodes the free-text query and a capped result limit against the Nominatim search endpoint', () => {
		const url = new URL(buildNominatimSearchUrl('Winthrop Gold, Rock Hill, SC'));
		expect(url.origin + url.pathname).toBe('https://nominatim.openstreetmap.org/search');
		expect(url.searchParams.get('q')).toBe('Winthrop Gold, Rock Hill, SC');
		expect(url.searchParams.get('format')).toBe('jsonv2');
		expect(url.searchParams.get('limit')).toBe(String(GEOCODE_RESULT_LIMIT));
	});
});

describe('searchPlace', () => {
	test('reports network and no-results failures as a typed result instead of throwing, and returns matches on success', async () => {
		const failingFetch: FetchLike = async () => {
			throw new TypeError('Failed to fetch');
		};
		const networkResult = await searchPlace('Winthrop Gold, Rock Hill, SC', { fetch: failingFetch });
		expect(networkResult.ok).toBe(false);
		if (!networkResult.ok) expect(networkResult.error.kind).toBe('network');

		const emptyFetch: FetchLike = async () =>
			new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
		const noResultsResult = await searchPlace('Someplace That Does Not Exist', { fetch: emptyFetch });
		expect(noResultsResult.ok).toBe(false);
		if (!noResultsResult.ok) expect(noResultsResult.error.kind).toBe('no-results');

		const httpErrorFetch: FetchLike = async () => new Response('', { status: 503 });
		const httpErrorResult = await searchPlace('Winthrop Gold, Rock Hill, SC', { fetch: httpErrorFetch });
		expect(httpErrorResult.ok).toBe(false);
		if (!httpErrorResult.ok) expect(httpErrorResult.error.kind).toBe('http-error');

		const okFetch: FetchLike = async () =>
			new Response(
				JSON.stringify([
					{ lat: '34.9249', lon: '-81.0251', display_name: 'Winthrop Gold, Rock Hill, York County, South Carolina' },
					{ lat: '34.9', lon: '-81.0', display_name: 'Rock Hill, York County, South Carolina' }
				]),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			);
		const okResult = await searchPlace('Winthrop Gold, Rock Hill, SC', { fetch: okFetch });
		expect(okResult.ok).toBe(true);
		if (okResult.ok) {
			expect(okResult.matches).toHaveLength(2);
			expect(okResult.matches[0]).toEqual({
				displayName: 'Winthrop Gold, Rock Hill, York County, South Carolina',
				lat: 34.9249,
				lon: -81.0251
			});
		}
	});

	test('parses a well-formed boundingbox into the match viewport and drops malformed ones (CHSPT-68)', async () => {
		const okFetch: FetchLike = async () =>
			new Response(
				JSON.stringify([
					{
						lat: '34.9249',
						lon: '-81.0251',
						display_name: 'Boxed Park',
						// Nominatim order: [minLat, maxLat, minLon, maxLon], as strings.
						boundingbox: ['34.92', '34.93', '-81.03', '-81.02']
					},
					{
						lat: '34.9',
						lon: '-81.0',
						display_name: 'Inverted Box Park',
						boundingbox: ['34.95', '34.93', '-81.03', '-81.02']
					},
					{
						lat: '34.8',
						lon: '-81.1',
						display_name: 'Malformed Box Park',
						boundingbox: ['34.92', 'not-a-number', '-81.03']
					},
					{ lat: '34.7', lon: '-81.2', display_name: 'No Box Park' }
				]),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			);
		const result = await searchPlace('Boxed Park', { fetch: okFetch });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.matches[0].viewport).toEqual({
			minLat: 34.92,
			maxLat: 34.93,
			minLon: -81.03,
			maxLon: -81.02
		});
		// A bad or missing box never fails the match itself.
		expect(result.matches[1].viewport).toBeUndefined();
		expect(result.matches[2].viewport).toBeUndefined();
		expect(result.matches[3].viewport).toBeUndefined();
		expect(result.matches[3].lat).toBe(34.7);
	});
});
