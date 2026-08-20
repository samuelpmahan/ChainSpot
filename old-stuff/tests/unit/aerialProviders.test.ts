import { describe, expect, test } from 'vitest';
import {
	AERIAL_PROVIDERS,
	buildAerialExportUrl,
	fetchAerialBoundingBoxWithFallback
} from '../../src/lib/aerialProviders';
import type { AerialFetchLike } from '../../src/lib/aerialProviders';

const BBOX = { minLon: -96.64, minLat: 33.17, maxLon: -96.63, maxLat: 33.18 };

describe('aerial provider prototype', () => {
	test('keeps USDA dynamic NAIP first and the cached USGS basemap last', () => {
		expect(AERIAL_PROVIDERS[0].id).toBe('usda-naip');
		expect(AERIAL_PROVIDERS[0].dynamic).toBe(true);
		expect(AERIAL_PROVIDERS.at(-1)?.id).toBe('usgs-imagery-only');
		expect(AERIAL_PROVIDERS.at(-1)?.dynamic).toBe(false);
	});

	test('builds WGS84 image-server and map-server export URLs', () => {
		const imageUrl = new URL(buildAerialExportUrl(AERIAL_PROVIDERS[0], BBOX, { widthPx: 2048, heightPx: 2048 }));
		expect(imageUrl.pathname).toContain('/ImageServer/exportImage');
		expect(imageUrl.searchParams.get('bboxSR')).toBe('4326');
		expect(imageUrl.searchParams.get('imageSR')).toBe('4326');
		expect(imageUrl.searchParams.get('size')).toBe('2048,2048');
		expect(imageUrl.searchParams.get('format')).toBe('png');

		const cachedUrl = new URL(
			buildAerialExportUrl(AERIAL_PROVIDERS.at(-1)!, BBOX, { widthPx: 2048, heightPx: 2048 })
		);
		expect(cachedUrl.pathname).toContain('/MapServer/export');
		expect(cachedUrl.searchParams.get('format')).toBe('png32');
	});

	test('falls through a CORS/network TypeError and returns the first readable image response', async () => {
		let call = 0;
		const fakeFetch: AerialFetchLike = async () => {
			call++;
			if (call === 1) throw new TypeError('Failed to fetch');
			return new Response(new Uint8Array([1, 2, 3]), {
				status: 200,
				headers: { 'content-type': 'image/png' }
			});
		};

		const result = await fetchAerialBoundingBoxWithFallback(
			BBOX,
			{ widthPx: 2048, heightPx: 2048 },
			{ fetch: fakeFetch, providers: AERIAL_PROVIDERS.slice(0, 2) }
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.provider.id).toBe('usgs-naip-plus');
		expect(result.attempts).toHaveLength(2);
		expect(result.attempts[0]).toMatchObject({ providerId: 'usda-naip', ok: false, kind: 'cors-or-network' });
		expect(result.attempts[1]).toMatchObject({ providerId: 'usgs-naip-plus', ok: true });
	});
});
