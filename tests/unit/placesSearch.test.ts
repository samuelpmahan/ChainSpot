import { describe, expect, test } from 'vitest';
import {
	buildPlacesSearchRequestBody,
	parseCoordinateInput,
	PLACES_RESULT_LIMIT,
	searchPlacesText
} from '../../src/lib/placesSearch';
import type { FetchLike } from '../../src/lib/placesSearch';

describe('buildPlacesSearchRequestBody', () => {
	test('builds the Text Search body with the US region constraint and default page size', () => {
		expect(buildPlacesSearchRequestBody("Dash's Track")).toEqual({
			textQuery: "Dash's Track",
			regionCode: 'us',
			pageSize: PLACES_RESULT_LIMIT
		});
	});

	test('honors an explicit page size', () => {
		expect(buildPlacesSearchRequestBody('Winthrop Gold', 3).pageSize).toBe(3);
	});
});

describe('searchPlacesText', () => {
	test('sends a POST with the API key header, field mask header, and JSON body', async () => {
		let capturedUrl: RequestInfo | URL | undefined;
		let capturedInit: RequestInit | undefined;
		const fetchSpy: FetchLike = async (url, init) => {
			capturedUrl = url;
			capturedInit = init;
			return new Response(JSON.stringify({ places: [] }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		};

		await searchPlacesText("Dash's Track, Frisco, TX", 'test-key-123', { fetch: fetchSpy });

		expect(String(capturedUrl)).toBe('https://places.googleapis.com/v1/places:searchText');
		expect(capturedInit?.method).toBe('POST');
		const headers = capturedInit?.headers as Record<string, string>;
		expect(headers['Content-Type']).toBe('application/json');
		expect(headers['X-Goog-Api-Key']).toBe('test-key-123');
		expect(headers['X-Goog-FieldMask']).toBe('places.displayName,places.formattedAddress,places.location');
		expect(JSON.parse(String(capturedInit?.body))).toEqual({
			textQuery: "Dash's Track, Frisco, TX",
			regionCode: 'us',
			pageSize: PLACES_RESULT_LIMIT
		});
	});

	test('maps a successful response to GeoSearchMatch, combining name and formatted address', async () => {
		const okFetch: FetchLike = async () =>
			new Response(
				JSON.stringify({
					places: [
						{
							displayName: { text: "Dash's Track" },
							formattedAddress: '123 Course Rd, Frisco, TX 75034, USA',
							location: { latitude: 33.1255, longitude: -96.861 }
						},
						{
							displayName: { text: 'No Address Course' },
							location: { latitude: 34.0, longitude: -97.0 }
						}
					]
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			);

		const result = await searchPlacesText("Dash's Track", 'key', { fetch: okFetch });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.matches).toHaveLength(2);
		expect(result.matches[0]).toEqual({
			displayName: "Dash's Track, 123 Course Rd, Frisco, TX 75034, USA",
			lat: 33.1255,
			lon: -96.861
		});
		expect(result.matches[1]).toEqual({
			displayName: 'No Address Course',
			lat: 34.0,
			lon: -97.0
		});
	});

	test('reports a network failure as a typed result instead of throwing', async () => {
		const failingFetch: FetchLike = async () => {
			throw new TypeError('Failed to fetch');
		};
		const result = await searchPlacesText('anything', 'key', { fetch: failingFetch });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe('network');
			expect(result.error.message.toLowerCase()).not.toContain('nominatim');
		}
	});

	test('reports a non-200 response as an http-error', async () => {
		const httpErrorFetch: FetchLike = async () => new Response('', { status: 403 });
		const result = await searchPlacesText('anything', 'key', { fetch: httpErrorFetch });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe('http-error');
			expect(result.error.message).toContain('403');
		}
	});

	test('reports a zero-length places array as no-results', async () => {
		const emptyFetch: FetchLike = async () =>
			new Response(JSON.stringify({ places: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
		const result = await searchPlacesText('Someplace That Does Not Exist', 'key', { fetch: emptyFetch });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe('no-results');
	});

	test('treats a malformed response body (no places array) as no-results rather than throwing', async () => {
		const malformedFetch: FetchLike = async () =>
			new Response(JSON.stringify({ unexpected: true }), { status: 200, headers: { 'content-type': 'application/json' } });
		const result = await searchPlacesText('anything', 'key', { fetch: malformedFetch });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe('no-results');
	});
});

describe('parseCoordinateInput', () => {
	test('parses "lat, lon"', () => {
		expect(parseCoordinateInput('33.1255, -96.8610')).toEqual({ lat: 33.1255, lon: -96.861 });
	});

	test('parses "lat lon" (bare whitespace separator)', () => {
		expect(parseCoordinateInput('33.1255 -96.8610')).toEqual({ lat: 33.1255, lon: -96.861 });
	});

	test('parses a Google Maps @lat,lon,zoom URL segment', () => {
		const url = 'https://www.google.com/maps/place/Dash%27s+Track/@33.1255,-96.8610,17z/data=!3m1!4b1';
		expect(parseCoordinateInput(url)).toEqual({ lat: 33.1255, lon: -96.861 });
	});

	test('parses a Google Maps ?q=lat,lon URL', () => {
		expect(parseCoordinateInput('https://maps.google.com/?q=33.1255,-96.8610')).toEqual({
			lat: 33.1255,
			lon: -96.861
		});
		expect(parseCoordinateInput('https://maps.google.com/maps?ll=0,0&q=33.1255,-96.8610&z=17')).toEqual({
			lat: 33.1255,
			lon: -96.861
		});
	});

	test('returns null for an ordinary course-name search query', () => {
		expect(parseCoordinateInput("Dash's Track")).toBeNull();
		expect(parseCoordinateInput('Winthrop Gold, Rock Hill, SC')).toBeNull();
	});

	test('returns null for out-of-range latitude/longitude', () => {
		expect(parseCoordinateInput('200, -96.8610')).toBeNull();
		expect(parseCoordinateInput('33.1255, -200')).toBeNull();
	});

	test('returns null for empty/whitespace input', () => {
		expect(parseCoordinateInput('')).toBeNull();
		expect(parseCoordinateInput('   ')).toBeNull();
	});
});
