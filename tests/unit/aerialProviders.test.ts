import { describe, expect, test } from 'vitest';
import { AERIAL_PROVIDERS, buildAerialExportUrl, fetchAerialWithFallback } from '../../src/lib/geo/aerialProviders';
import { bboxFromCenter } from '../../src/lib/naip';

const bbox = bboxFromCenter({ lat: 33.1255, lon: -96.861 }, 300);
const size = { widthPx: 2048, heightPx: 2048 };

/** A fake fetch keyed by host: 'refuse' throws like a proxy refusal, a number is an HTTP status, 'json' is a 200 non-image. */
function fakeFetch(byHost: Record<string, 'refuse' | number | 'json' | 'png'>, calls: string[]): typeof fetch {
	return (async (input: RequestInfo | URL) => {
		const url = String(input);
		calls.push(url);
		const outcome = byHost[new URL(url).host] ?? 'refuse';
		if (outcome === 'refuse') throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET', message: 'Request was cancelled.' } });
		if (outcome === 'json') return new Response('{"error":{}}', { status: 200, headers: { 'content-type': 'application/json' } });
		if (typeof outcome === 'number') return new Response('', { status: outcome });
		return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200, headers: { 'content-type': 'image/png' } });
	}) as typeof fetch;
}

describe('fetchAerialWithFallback', () => {
	test('keeps the old order: USDA NAIP, USGS NAIP Plus, USGS NAIP, USGS ImageryOnly', () => {
		expect(AERIAL_PROVIDERS.map((p) => p.id)).toEqual(['usda-naip', 'usgs-naip-plus', 'usgs-naip', 'usgs-imagery-only']);
	});

	test('falls through refused and failing providers and records which one served', async () => {
		const calls: string[] = [];
		const result = await fetchAerialWithFallback(bbox, size, {
			fetch: fakeFetch({ 'apps.geo.fpac.usda.gov': 'refuse', 'imagery.nationalmap.gov': 403, 'basemap.nationalmap.gov': 'png' }, calls)
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.provider.id).toBe('usgs-imagery-only');
		expect(result.attempts.map((a) => [a.providerId, a.ok, a.kind ?? null])).toEqual([
			['usda-naip', false, 'network'],
			['usgs-naip-plus', false, 'http-error'],
			['usgs-naip', false, 'http-error'],
			['usgs-imagery-only', true, null]
		]);
		expect(result.attempts[0].message).toContain('Request was cancelled.');
		expect(calls).toHaveLength(4);
	});

	test('stops at the first provider that serves an image', async () => {
		const calls: string[] = [];
		const result = await fetchAerialWithFallback(bbox, size, { fetch: fakeFetch({ 'apps.geo.fpac.usda.gov': 'png' }, calls) });
		expect(result.ok && result.provider.id).toBe('usda-naip');
		expect(calls).toHaveLength(1);
	});

	test('every provider failing is a result listing every attempt, not a throw', async () => {
		const result = await fetchAerialWithFallback(bbox, size, { fetch: fakeFetch({ 'imagery.nationalmap.gov': 'json' }, []) });
		expect(result.ok).toBe(false);
		expect(result.attempts.map((a) => a.kind)).toEqual(['network', 'bad-content-type', 'bad-content-type', 'network']);
	});

	test('a size over a provider cap is recorded and skipped', async () => {
		const result = await fetchAerialWithFallback(bbox, { widthPx: 4096, heightPx: 4096 }, { fetch: fakeFetch({ 'basemap.nationalmap.gov': 'png' }, []) });
		expect(result.ok && result.provider.id).toBe('usgs-imagery-only');
		expect(result.attempts.map((a) => a.kind ?? 'ok')).toEqual(['network', 'size-cap', 'size-cap', 'ok']);
	});

	test('every URL is WGS84 in and out, so one bbox has one ground scale everywhere', () => {
		for (const provider of AERIAL_PROVIDERS.slice(1)) {
			const url = new URL(buildAerialExportUrl(provider, bbox, size));
			expect(url.searchParams.get('bboxSR')).toBe('4326');
			expect(url.searchParams.get('imageSR')).toBe('4326');
			expect(url.searchParams.get('size')).toBe('2048,2048');
		}
	});
});
