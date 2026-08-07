import { describe, expect, test } from 'vitest';
import {
	bboxFromCenter,
	buildNaipExportUrl,
	fetchNaipImage,
	NAIP_EXPORT_SIZE_PX
} from '../../src/lib/naip';
import type { FetchLike } from '../../src/lib/naip';

describe('bboxFromCenter + buildNaipExportUrl', () => {
	test('computes a centered WGS84 box (narrower in longitude away from the equator) and encodes it into the exportImage URL', () => {
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
			'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage'
		);
		expect(url.searchParams.get('bboxSR')).toBe('4326');
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

		// NAIP's exportImage returns a 200 JSON error body (not a non-2xx status) when
		// there is no coverage at the requested location — content-type is the only
		// reliable signal, which is exactly what this branch checks.
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
		const okFetch: FetchLike = async () =>
			new Response(pngBytes, { status: 200, headers: { 'content-type': 'image/png' } });
		const okResult = await fetchNaipImage({ lat: 45, lon: -93 }, 200, { fetch: okFetch });
		expect(okResult.ok).toBe(true);
		if (okResult.ok) expect(okResult.blob.size).toBe(pngBytes.byteLength);
	});
});
