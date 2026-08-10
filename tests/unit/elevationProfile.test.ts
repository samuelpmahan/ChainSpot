import { describe, expect, test } from 'vitest';
import {
	buildElevationProfile,
	buildEpqsUrl,
	naipGridGeoReference,
	naipImageGeoReference,
	pixelToGeo,
	renderElevationProfile,
	resampleGeoReferencedPath
} from '../../src/lib/elevationProfile';
import type {
	ElevationProfile,
	ElevationProfileRenderEnv,
	GeoRasterReference
} from '../../src/lib/elevationProfile';
import { planTileGrid } from '../../src/lib/naipGrid';

describe('NAIP pixel georeferencing', () => {
	test('maps the center of a single NAIP export back to its requested center', () => {
		const center = { lat: 33.1234, lon: -96.4321 };
		const reference = naipImageGeoReference(center, 300, 2000);
		const mapped = pixelToGeo({ xPx: 1000, yPx: 1000 }, reference);
		expect(mapped.lat).toBeCloseTo(center.lat, 10);
		expect(mapped.lon).toBeCloseTo(center.lon, 10);
	});

	test('uses the actual tile bbox on each side of a mosaic boundary', () => {
		const plan = planTileGrid({ lat: 33, lon: -96 }, 1200, 300, 300);
		const reference = naipGridGeoReference(plan, 100);
		expect(plan.cols).toBe(2);
		const leftTile = reference.tiles[0];
		const rightTile = reference.tiles[1];

		const justLeft = pixelToGeo({ xPx: 99.999, yPx: 50 }, reference);
		const atRight = pixelToGeo({ xPx: 100, yPx: 50 }, reference);
		expect(justLeft.lon).toBeCloseTo(leftTile.bbox.maxLon, 5);
		expect(atRight.lon).toBeCloseTo(rightTile.bbox.minLon, 10);
	});

	test('rejects a target pixel outside the georeferenced raster', () => {
		const reference = naipImageGeoReference({ lat: 33, lon: -96 }, 300, 100);
		expect(() => pixelToGeo({ xPx: 100, yPx: 50 }, reference)).toThrow(/outside/);
	});
});

describe('route resampling', () => {
	const reference: GeoRasterReference = {
		widthPx: 1000,
		heightPx: 1000,
		tiles: [
		{
			xPx: 0,
			yPx: 0,
			widthPx: 1000,
			heightPx: 1000,
			bbox: { minLon: -96.01, minLat: 32.99, maxLon: -95.99, maxLat: 33.01 }
		}
		]
	};

	test('walks a dogleg rather than interpolating straight from tee to basket', () => {
		const samples = resampleGeoReferencedPath(
			[
				{ xPx: 100, yPx: 800 },
				{ xPx: 100, yPx: 200 },
				{ xPx: 800, yPx: 200 }
			],
			reference,
			{ maxSamples: 9, sampleSpacingMeters: 1 }
		);
		expect(samples).toHaveLength(9);
		expect(samples[0].pixel).toEqual({ xPx: 100, yPx: 800 });
		expect(samples.at(-1)?.pixel).toEqual({ xPx: 800, yPx: 200 });
		// At least one interior sample must still be on the vertical first leg.
		expect(samples.slice(1, -1).some((sample) => Math.abs(sample.pixel.xPx - 100) < 1e-8)).toBe(true);
		// And at least one must be on the horizontal second leg.
		expect(samples.slice(1, -1).some((sample) => Math.abs(sample.pixel.yPx - 200) < 1e-8)).toBe(true);
	});

	test('caps the number of public-service lookups', () => {
		const samples = resampleGeoReferencedPath(
			[
				{ xPx: 0, yPx: 500 },
				{ xPx: 999, yPx: 500 }
			],
			reference,
			{ sampleSpacingMeters: 0.1, maxSamples: 12 }
		);
		expect(samples).toHaveLength(12);
	});
});

describe('USGS EPQS sampling', () => {
	test('builds the current WGS84 point-query URL', () => {
		const url = new URL(buildEpqsUrl({ lat: 33.1, lon: -96.2 }, 'Feet'));
		expect(url.origin + url.pathname).toBe('https://epqs.nationalmap.gov/v1/json');
		expect(url.searchParams.get('x')).toBe('-96.2');
		expect(url.searchParams.get('y')).toBe('33.1');
		expect(url.searchParams.get('units')).toBe('Feet');
		expect(url.searchParams.get('wkid')).toBe('4326');
	});

	test('keeps concurrent responses in route order and computes profile stats', async () => {
		const reference = naipImageGeoReference({ lat: 33, lon: -96 }, 100, 100);
		let call = 0;
		const values = [500, 490, 515, 510];
		const fetchImpl: typeof fetch = async () => {
			const index = call++;
			await new Promise((resolve) => setTimeout(resolve, (3 - index) * 2));
			return new Response(JSON.stringify({ value: values[index] }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		};
		const profile = await buildElevationProfile(
			[
				{ xPx: 10, yPx: 50 },
				{ xPx: 90, yPx: 50 }
			],
			reference,
			{ fetch: fetchImpl, maxSamples: 4, sampleSpacingMeters: 0.1, concurrency: 4 }
		);

		expect(profile.samples.map((sample) => sample.elevation)).toEqual(values);
		expect(profile.minElevation).toBe(490);
		expect(profile.maxElevation).toBe(515);
		expect(profile.totalClimb).toBe(25);
		expect(profile.totalDescent).toBe(15);
		expect(profile.totalDistanceMeters).toBeGreaterThan(0);
	});

	test('fails rather than fabricating a point when EPQS returns no numeric value', async () => {
		const reference = naipImageGeoReference({ lat: 33, lon: -96 }, 100, 100);
		const fetchImpl: typeof fetch = async () =>
			new Response(JSON.stringify({ value: null }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		await expect(
			buildElevationProfile(
				[
					{ xPx: 10, yPx: 50 },
					{ xPx: 90, yPx: 50 }
				],
				reference,
				{ fetch: fetchImpl, maxSamples: 2 }
			)
		).rejects.toMatchObject({ kind: 'bad-payload' });
	});
});

describe('broadcast profile renderer', () => {
	function profile(): ElevationProfile {
		return {
			units: 'Feet',
			totalDistanceMeters: 100,
			minElevation: 480,
			maxElevation: 520,
			totalClimb: 40,
			totalDescent: 20,
			samples: [
				{ pixel: { xPx: 0, yPx: 0 }, point: { lat: 0, lon: 0 }, distanceMeters: 0, elevation: 520 },
				{ pixel: { xPx: 1, yPx: 1 }, point: { lat: 0, lon: 0 }, distanceMeters: 50, elevation: 480 },
				{ pixel: { xPx: 2, yPx: 2 }, point: { lat: 0, lon: 0 }, distanceMeters: 100, elevation: 500 }
			]
		};
	}

	test('draws the black field, title, and one rounded profile stroke', async () => {
		const calls: string[] = [];
		const canvas = { width: 0, height: 0 };
		const context = {
			fillStyle: '',
			strokeStyle: '',
			font: '',
			textAlign: 'start',
			textBaseline: 'alphabetic',
			lineWidth: 0,
			lineCap: 'butt',
			lineJoin: 'miter',
			fillRect: () => calls.push('fillRect'),
			fillText: () => calls.push('fillText'),
			beginPath: () => calls.push('beginPath'),
			moveTo: () => calls.push('moveTo'),
			lineTo: () => calls.push('lineTo'),
			stroke: () => calls.push('stroke')
		};
		const env: ElevationProfileRenderEnv = {
			createCanvas: () => Object.assign(canvas, { getContext: () => context }) as unknown as HTMLCanvasElement,
			toBlob: async () => new Blob(['profile'])
		};

		const blob = await renderElevationProfile(profile(), { widthPx: 800, heightPx: 450 }, env);
		expect(canvas.width).toBe(800);
		expect(canvas.height).toBe(450);
		expect(calls.filter((call) => call === 'fillRect')).toHaveLength(1);
		expect(calls.filter((call) => call === 'fillText')).toHaveLength(1);
		expect(calls.filter((call) => call === 'stroke')).toHaveLength(1);
		expect(context.lineCap).toBe('round');
		expect(context.lineJoin).toBe('round');
		expect(blob.size).toBeGreaterThan(0);
	});
});
