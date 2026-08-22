import { describe, expect, test } from 'vitest';
import {
	bboxFromCenter,
	pixelToGeo,
	geoToPixel,
	buildAerialExportUrl,
	AERIAL_PROVIDERS,
	type GeoRaster
} from '$lib/satellite';

describe('bboxFromCenter <-> pixelToGeo/geoToPixel round-trip', () => {
	const center = { lat: 45.5, lon: -122.6 };
	const radiusMeters = 300;
	const bbox = bboxFromCenter(center, radiusMeters);
	const raster: GeoRaster = { bbox, widthPx: 1000, heightPx: 1000 };

	test('center pixel maps back to the center point', () => {
		const centerPx = geoToPixel(raster, center);
		expect(centerPx.xPx).toBeCloseTo(500, 3);
		expect(centerPx.yPx).toBeCloseTo(500, 3);

		const backToGeo = pixelToGeo(raster, centerPx);
		expect(backToGeo.lat).toBeCloseTo(center.lat, 9);
		expect(backToGeo.lon).toBeCloseTo(center.lon, 9);
	});

	test('corner pixels map to the bbox corners', () => {
		const topLeft = pixelToGeo(raster, { xPx: 0, yPx: 0 });
		expect(topLeft.lon).toBeCloseTo(bbox.minLon, 9);
		expect(topLeft.lat).toBeCloseTo(bbox.maxLat, 9);

		const bottomRight = pixelToGeo(raster, { xPx: 1000, yPx: 1000 });
		expect(bottomRight.lon).toBeCloseTo(bbox.maxLon, 9);
		expect(bottomRight.lat).toBeCloseTo(bbox.minLat, 9);

		const topLeftPx = geoToPixel(raster, { lat: bbox.maxLat, lon: bbox.minLon });
		expect(topLeftPx.xPx).toBeCloseTo(0, 6);
		expect(topLeftPx.yPx).toBeCloseTo(0, 6);
	});

	test('geoToPixel(pixelToGeo(p)) is an identity for arbitrary points', () => {
		const points = [
			{ xPx: 123.456, yPx: 789.012 },
			{ xPx: 0, yPx: 1000 },
			{ xPx: 1000, yPx: 0 },
			{ xPx: 250.5, yPx: 999.9 }
		];
		for (const p of points) {
			const geo = pixelToGeo(raster, p);
			const back = geoToPixel(raster, geo);
			expect(back.xPx).toBeCloseTo(p.xPx, 6);
			expect(back.yPx).toBeCloseTo(p.yPx, 6);
		}
	});

	test('pixelToGeo(geoToPixel(g)) is an identity for arbitrary geo points within the bbox', () => {
		const geoPoints = [
			{ lat: 45.5005, lon: -122.5995 },
			{ lat: 45.497, lon: -122.603 }
		];
		for (const g of geoPoints) {
			const px = geoToPixel(raster, g);
			const back = pixelToGeo(raster, px);
			expect(back.lat).toBeCloseTo(g.lat, 9);
			expect(back.lon).toBeCloseTo(g.lon, 9);
		}
	});
});

describe('buildAerialExportUrl', () => {
	test('builds expected exportImage query params for the USDA NAIP provider', () => {
		const provider = AERIAL_PROVIDERS.find((p) => p.id === 'usda-naip')!;
		const bbox = { minLon: -122.61, minLat: 45.49, maxLon: -122.59, maxLat: 45.51 };
		const url = buildAerialExportUrl(provider, bbox, 512);

		const parsed = new URL(url);
		expect(parsed.origin + parsed.pathname).toBe(provider.baseUrl);

		const params = parsed.searchParams;
		expect(params.get('bbox')).toBe('-122.61,45.49,-122.59,45.51');
		expect(params.get('bboxSR')).toBe('4326');
		expect(params.get('imageSR')).toBe('4326');
		expect(params.get('size')).toBe('512,512');
		expect(params.get('format')).toBe('png');
		expect(params.get('f')).toBe('image');
	});

	test('builds png32 format for the map-server (cached fallback) provider', () => {
		const provider = AERIAL_PROVIDERS.find((p) => p.id === 'usgs-imagery-only')!;
		const bbox = { minLon: -122.61, minLat: 45.49, maxLon: -122.59, maxLat: 45.51 };
		const url = buildAerialExportUrl(provider, bbox, 256);
		const params = new URL(url).searchParams;
		expect(params.get('format')).toBe('png32');
		expect(params.get('size')).toBe('256,256');
	});

	test('throws when requested size exceeds the provider cap', () => {
		const provider = AERIAL_PROVIDERS.find((p) => p.id === 'usgs-naip')!;
		const bbox = { minLon: -122.61, minLat: 45.49, maxLon: -122.59, maxLat: 45.51 };
		expect(() => buildAerialExportUrl(provider, bbox, provider.maxWidthPx + 1)).toThrow();
	});
});
