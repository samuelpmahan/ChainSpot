import { describe, expect, test } from 'vitest';
import { AERIAL_PROVIDERS, buildAerialExportUrl, fetchAerialWithFallback } from '../../src/lib/geo/aerialProviders';
import { bboxFromCenter } from '../../src/lib/naip';

const bbox = bboxFromCenter({ lat: 33.1255, lon: -96.861 }, 300);
const size = { widthPx: 2048, heightPx: 2048 };
const EXTENT = { xmin: -10782995.87, ymin: 3911495.2, xmax: -10782038.52, ymax: 3912452.55, spatialReference: { wkid: 102100, latestWkid: 3857 } };

type Outcome = 'refuse' | number | 'bad-json' | 'ok' | 'href-400';

/**
 * A fake fetch keyed by host. 'refuse' throws like a proxy refusal; a number is an HTTP status for the export;
 * 'bad-json' is a 200 that is not the export JSON; 'ok' serves JSON then the image at its href; 'href-400' serves
 * JSON whose href answers 400, while the same export as f=image serves the image.
 */
function fakeFetch(byHost: Record<string, Outcome>, calls: string[]): typeof fetch {
	return (async (input: RequestInfo | URL) => {
		const url = String(input);
		calls.push(url);
		const parsed = new URL(url);
		const outcome = byHost[parsed.host] ?? 'refuse';
		const png = () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200, headers: { 'content-type': 'image/png' } });
		if (outcome === 'refuse') throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET', message: 'Request was cancelled.' } });
		if (typeof outcome === 'number') return new Response('', { status: outcome });
		if (parsed.pathname.endsWith('.png')) return outcome === 'href-400' ? new Response('<html>', { status: 400, headers: { 'content-type': 'text/html' } }) : png();
		if (parsed.searchParams.get('f') === 'image') return png();
		if (outcome === 'bad-json') return new Response('<html>oops</html>', { status: 200, headers: { 'content-type': 'text/html' } });
		return Response.json({ href: `https://${parsed.host}/out/_ags_1.png`, width: 2048, height: 2048, extent: EXTENT });
	}) as typeof fetch;
}

describe('fetchAerialWithFallback', () => {
	test('keeps the old order: USDA NAIP, USGS NAIP Plus, USGS NAIP, USGS ImageryOnly', () => {
		expect(AERIAL_PROVIDERS.map((p) => p.id)).toEqual(['usda-naip', 'usgs-naip-plus', 'usgs-naip', 'usgs-imagery-only']);
	});

	test('falls through refused and failing providers, records which one served, and returns the rendered extent', async () => {
		const calls: string[] = [];
		const result = await fetchAerialWithFallback(bbox, size, {
			fetch: fakeFetch({ 'apps.geo.fpac.usda.gov': 'refuse', 'imagery.nationalmap.gov': 403, 'basemap.nationalmap.gov': 'ok' }, calls)
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.provider.id).toBe('usgs-imagery-only');
		expect(result.raster).toEqual({ widthPx: 2048, heightPx: 2048, extent: { xmin: EXTENT.xmin, ymin: EXTENT.ymin, xmax: EXTENT.xmax, ymax: EXTENT.ymax } });
		expect(result.imageUrl).toBe('https://basemap.nationalmap.gov/out/_ags_1.png');
		expect(result.attempts.map((a) => [a.providerId, a.ok, a.kind ?? null])).toEqual([
			['usda-naip', false, 'network'],
			['usgs-naip-plus', false, 'http-error'],
			['usgs-naip', false, 'http-error'],
			['usgs-imagery-only', true, null]
		]);
		expect(result.attempts[0].message).toContain('Request was cancelled.');
	});

	test('an href that answers 400 falls back to the same export as f=image (USDA behaviour)', async () => {
		const calls: string[] = [];
		const result = await fetchAerialWithFallback(bbox, size, { fetch: fakeFetch({ 'apps.geo.fpac.usda.gov': 'href-400' }, calls) });
		expect(result.ok && result.provider.id).toBe('usda-naip');
		if (!result.ok) return;
		expect(new URL(result.imageUrl).searchParams.get('f')).toBe('image');
		expect(result.attempts.map((a) => a.kind ?? 'ok')).toEqual(['http-error', 'ok']);
	});

	test('every provider failing is a result listing every attempt, not a throw', async () => {
		const result = await fetchAerialWithFallback(bbox, size, { fetch: fakeFetch({ 'imagery.nationalmap.gov': 'bad-json' }, []) });
		expect(result.ok).toBe(false);
		expect(result.attempts.map((a) => a.kind)).toEqual(['network', 'bad-json', 'bad-json', 'network']);
	});

	test('a size over a provider cap is recorded and skipped', async () => {
		const result = await fetchAerialWithFallback(bbox, { widthPx: 4096, heightPx: 4096 }, { fetch: fakeFetch({ 'basemap.nationalmap.gov': 'ok' }, []) });
		expect(result.ok).toBe(false);
		expect(result.attempts.map((a) => a.kind)).toEqual(['network', 'size-cap', 'size-cap', 'bad-json']);
	});

	test('asks for EPSG:3857 output and JSON, so pixels are square on the ground and the extent is reported', () => {
		for (const provider of AERIAL_PROVIDERS) {
			const url = new URL(buildAerialExportUrl(provider, bbox, size));
			expect(url.searchParams.get('bboxSR')).toBe('4326');
			expect(url.searchParams.get('imageSR')).toBe('3857');
			expect(url.searchParams.get('f')).toBe('json');
			expect(url.searchParams.get('size')).toBe('2048,2048');
		}
	});
});
