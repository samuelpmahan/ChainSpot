import { describe, expect, test } from 'vitest';
import {
	bboxFromCenter,
	buildNaipExportUrl,
	fetchNaipBoundingBoxImage,
	fetchNaipImage,
	NAIP_EXPORT_SIZE_PX
} from '../../src/lib/naip';
import type { FetchLike } from '../../src/lib/naip';

describe('bboxFromCenter + buildNaipExportUrl', () => {
	test('computes a centered WGS84 box and encodes it into the browser-fetchable USGS imagery export URL', () => {
		// A mid-latitude US course: at 45 degrees north, cos(45) ~ 0.707, so a degree
		// of longitude covers fewer meters than a degree of latitude, and the box
		// should be measurably wider in longitude-degrees than latitude-degrees for
		// the same physical radius.
		const center = { lat: 45, lon: -93 };
		const bbox = bboxFromCenter(center, 200);

		expect((bbox.minLon + bbox.maxLon) / 2).toBeCloseTo(center.lon, 9);
		expect((bbox.minLat + bbox.maxLat) / 2).toBeCloseTo(center.lat, 9);
		expect(bbox.maxLon - bbox.minLon).toBeGreaterThan(bbox.maxLat - bbox.minLat);

		const url = new URL(buildNaipExportUrl(bbox));
		expect(url.origin + url.pathname).toBe(
			'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/export'
		);
		expect(url.searchParams.get('bboxSR')).toBe('4326');
		expect(url.searchParams.get('imageSR')).toBe('4326');
		expect(url.searchParams.get('size')).toBe(`${NAIP_EXPORT_SIZE_PX},${NAIP_EXPORT_SIZE_PX}`);
		expect(url.searchParams.get('format')).toBe('png');
		expect(url.searchParams.get('f')).toBe('image');
	});
});

describe('fetchNaipImage', () => {
	test('reports network and no-coverage failures as a typed result instead of throwing, and returns the blob on success', async () => {
		const failingFetch: FetchLike = async () => {
			throw new TypeError('Failed to fetch');
		};
		const networkResult = await fetchNaipImage({ lat: 45, lon: -93 }, 200, { fetch: failingFetch });
		expect(networkResult.ok).toBe(false);
		if (!networkResult.ok) expect(networkResult.error.kind).toBe('network');

		const jsonErrorFetch: FetchLike = async () =>
			new Response(JSON.stringify({ error: { message: 'no imagery' } }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		const noCoverageResult = await fetchNaipImage({ lat: 45, lon: -93 }, 200, {
			fetch: jsonErrorFetch
		});
		expect(noCoverageResult.ok).toBe(false);
		if (!noCoverageResult.ok) expect(noCoverageResult.error.kind).toBe('bad-content-type');

		const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
		let requestedUrl = '';
		const okFetch: FetchLike = async (input) => {
			requestedUrl = String(input);
			return new Response(pngBytes, { status: 200, headers: { 'content-type': 'image/png' } });
		};
		const okResult = await fetchNaipImage({ lat: 45, lon: -93 }, 200, { fetch: okFetch });
		expect(okResult.ok).toBe(true);
		if (okResult.ok) expect(okResult.blob.size).toBe(pngBytes.byteLength);

		const exactResult = await fetchNaipBoundingBoxImage(
			{ minLon: -93.01, minLat: 44.99, maxLon: -92.99, maxLat: 45.01 },
			{ widthPx: 1292, heightPx: 2048, fetch: okFetch }
		);
		expect(exactResult.ok).toBe(true);
		expect(new URL(requestedUrl).searchParams.get('size')).toBe('1292,2048');
	});
});
